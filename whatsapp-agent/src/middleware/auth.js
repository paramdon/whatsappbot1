// src/middleware/auth.js

const db = require('../db/database');

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/admin/login');
}

function requireClient(req, res, next) {
  if (!req.session || !req.session.clientId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/dashboard/login');
  }

  const client = db.getClient(req.session.clientId);
  if (!client) return res.redirect('/dashboard/login');

  if (!db.isClientActive(req.session.clientId)) {
    req.session.destroy();
    return res.redirect('/dashboard/login?expired=1');
  }

  req.client = client;
  next();
}

module.exports = { requireAdmin, requireClient };
