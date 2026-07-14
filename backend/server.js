// 🌐 Backend Concours Med Belgique
// Validation PayPal IPN + API pour le site frontend
// Déploiement : Render / Railway / Fly.io / VPS

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: ['https://concours-med-belgique.surge.sh', 'http://localhost:3000'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// Stockage temporaire en mémoire (remplacer par Firestore quand Firebase est actif)
// ============================================================
const db = {
  transactions: new Map(),   // txId → { email, status, timestamp }
  users: new Map(),          // email → { premium: bool, txId, since }
};

// ============================================================
// 🔐 PayPal IPN Verification Webhook
// ============================================================
// Avec PayPal IPN (Instant Payment Notification), PayPal envoie une requête POST
// à cette URL après chaque paiement. Le serveur vérifie la signature et active l'accès.
//
// Pour activer IPN dans PayPal :
// 1. Va sur https://www.paypal.com → Outils → Notifications IPN
// 2. Ajoute https://TON_SERVEUR/api/paypal/ipn
// 3. Coche "Recevoir les notifications IPN"
// ============================================================

app.post('/api/paypal/ipn', async (req, res) => {
  // Étape 1 : Renvoyer le message à PayPal pour vérification (IPN protocol)
  const verificationBody = 'cmd=_notify-validate&' + req.rawBody || req.body.toString();

  try {
    const verificationResponse = await axios.post(
      process.env.PAYPAL_SANDBOX === 'true'
        ? 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'
        : 'https://ipnpb.paypal.com/cgi-bin/webscr',
      verificationBody,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (verificationResponse.data !== 'VERIFIED') {
      console.warn('[IPN] INVALIDE — signature non vérifiée');
      return res.status(400).send('INVALID');
    }

    // Étape 2 : Vérifier les détails de la transaction
    const { payment_status, txn_id, receiver_email, mc_gross, mc_currency, payer_email, custom } = req.body;

    if (payment_status !== 'Completed') {
      console.log(`[IPN] Paiement non complété : ${payment_status}`);
      return res.status(200).send('OK');
    }

    // Vérifier que le destinataire est le bon
    if (receiver_email !== process.env.PAYPAL_EMAIL + '@gmail.com' &&
        receiver_email !== process.env.PAYPAL_EMAIL) {
      console.warn(`[IPN] Mauvais destinataire : ${receiver_email}`);
      return res.status(200).send('OK');
    }

    // Vérifier le montant
    const expectedAmount = process.env.PAYPAL_PRICE || '50';
    if (mc_gross !== expectedAmount || mc_currency !== (process.env.PAYPAL_CURRENCY || 'EUR')) {
      console.warn(`[IPN] Montant incorrect : ${mc_gross} ${mc_currency}`);
      return res.status(200).send('OK');
    }

    // Étape 3 : Activer l'accès premium
    const userEmail = custom || payer_email;  // "custom" peut contenir l'email du site
    db.transactions.set(txn_id, {
      email: userEmail,
      status: 'completed',
      timestamp: new Date().toISOString(),
      payerEmail: payer_email,
      amount: mc_gross,
    });

    db.users.set(userEmail, {
      premium: true,
      txId: txn_id,
      since: new Date().toISOString(),
    });

    console.log(`[✅ IPN] Premium activé pour ${userEmail} — transaction ${txn_id}`);

    // Notifier l'admin via Telegram (si configuré)
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `✅ Nouveau paiement Premium reçu !\nEmail : ${userEmail}\nTransaction : ${txn_id}\nMontant : ${mc_gross}${mc_currency}\nPayPal : ${payer_email}`,
        });
      } catch (e) {
        console.warn('[IPN] Erreur notification Telegram:', e.message);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[IPN] Erreur :', err.message);
    res.status(500).send('ERROR');
  }
});

// ============================================================
// 📋 Alternative : Webhook manuel (quand l'utilisateur entre son txId)
// ============================================================
// Le site frontend envoie le txId saisi par l'utilisateur ici.
// Le serveur vérifie via PayPal REST API (nécessite credentials API PayPal)
// Sinon, marque comme "pending" pour vérification manuelle.

app.post('/api/validate-tx', async (req, res) => {
  const { txId, email } = req.body;

  if (!txId || !email) {
    return res.status(400).json({ error: 'txId et email requis' });
  }

  // Vérifier si déjà connu (IPN automatique)
  if (db.transactions.has(txId)) {
    const tx = db.transactions.get(txId);
    if (tx.status === 'completed') {
      return res.json({ status: 'premium', message: '✅ Accès Premium activé !' });
    }
  }

  // Enregistrer comme en attente
  db.transactions.set(txId, {
    email,
    status: 'pending',
    timestamp: new Date().toISOString(),
  });

  db.users.set(email, {
    premium: false,
    txPending: true,
    txId,
    since: null,
  });

  // Notifier l'admin
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `🔔 Nouvelle validation en attente !\nEmail : ${email}\nTransaction : ${txId}\n👉 Valider avec /approve ${email}`,
      });
    } catch (e) {
      console.warn('[TX] Erreur notification Telegram:', e.message);
    }
  }

  return res.json({
    status: 'pending',
    message: '✅ Transaction enregistrée ! En attente de validation par l\'admin.',
    note: 'Pour un accès immédiat, contacte @Jtrx_2 sur Telegram',
  });
});

// ============================================================
// 🔑 Admin : Vérifier statut d'un utilisateur
// ============================================================

app.get('/api/user-status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  const user = db.users.get(email);
  if (!user) return res.json({ premium: false, exists: false });

  return res.json({
    premium: user.premium,
    txPending: user.txPending || false,
    exists: true,
    since: user.since,
  });
});

// ============================================================
// 🎯 Admin : Approuver manuellement un utilisateur
// ============================================================

app.post('/api/admin/approve', (req, res) => {
  const { email, secret } = req.body;

  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Non autorisé' });
  }

  const user = db.users.get(email);
  if (!user) return res.status(404).json({ error: 'Utilisateur inconnu' });

  user.premium = true;
  user.txPending = false;
  user.since = new Date().toISOString();
  db.users.set(email, user);

  console.log(`[✅ ADMIN] Premium activé manuellement pour ${email}`);
  res.json({ status: 'approved', message: `✅ Premium activé pour ${email}` });
});

// ============================================================
// 🏠 Health check
// ============================================================

app.get('/', (req, res) => {
  res.json({
    service: 'Concours Med Belgique — Backend',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      paypalIpn: 'POST /api/paypal/ipn — Webhook PayPal IPN',
      validateTx: 'POST /api/validate-tx — Valider une transaction manuelle',
      userStatus: 'GET /api/user-status?email= — Vérifier statut utilisateur',
      adminApprove: 'POST /api/admin/approve — Approuver manuellement (admin)',
    },
    firebase: process.env.FIREBASE_PROJECT_ID ? '✅ Configuré' : '⚠️ Non configuré — voir FIREBASE_SETUP.md',
  });
});

// ============================================================
// Démarrage
// ============================================================

app.listen(PORT, () => {
  console.log(`\n🚀 Serveur démarré sur http://localhost:${PORT}`);
  console.log(`📋 Health : http://localhost:${PORT}/`);
  console.log(`⚡ PayPal IPN : POST http://localhost:${PORT}/api/paypal/ipn`);
  console.log(`\n⚠️ Firebase : ${process.env.FIREBASE_PROJECT_ID ? '✅ Configuré' : '❌ Non configuré'}`);
  console.log(`   → Voir FIREBASE_SETUP.md pour les instructions`);
});
