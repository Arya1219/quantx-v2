require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Google Sheets Auth ──
function getAuth() {
  const creds = process.env.GOOGLE_CREDENTIALS;
  if (creds) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(creds),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  return new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

const SHEET_ID = process.env.SHEET_ID;

// ── In-memory store ──
// participants: { [name_lowercase]: { id, name, cash, position, units, entryPrice, totalPnl, round, registeredAt } }
let participants = {};

// Game state
let gameState = {
  currentRound: 0,
  timerActive: false,
  currentImage: '',
  currentPrice: 1000,
  correctDirection: '',
  gameActive: false
};

// ── Sheets helpers ──
async function syncParticipantToSheet(p) {
  try {
    const sheets = await getSheets();
    // Check if row exists
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:A'
    });
    const ids = (res.data.values || []).map(r => r[0]);
    const rowIndex = ids.indexOf(p.id);
    const row = [p.id, p.name, p.email||'', p.cash, p.position, p.units, p.entryPrice, p.totalPnl, p.round, p.registeredAt];

    if (rowIndex === -1) {
      // Append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A:I',
        valueInputOption: 'RAW',
        resource: { values: [row] }
      });
    } else {
      // Update existing row
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Sheet1!A${rowIndex + 1}:I${rowIndex + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [row] }
      });
    }
  } catch (e) {
    console.error('Sheet sync error:', e.message);
  }
}

async function syncAllToSheet() {
  try {
    const sheets = await getSheets();
    const allRows = Object.values(participants).map(p =>
      [p.id, p.name, p.email||'', p.cash, p.position, p.units, p.entryPrice, p.totalPnl, p.round, p.registeredAt]
    );
    if (!allRows.length) return;
    // Clear and rewrite all data
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A2:I1000'
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A2',
      valueInputOption: 'RAW',
      resource: { values: allRows }
    });
  } catch (e) {
    console.error('Full sync error:', e.message);
  }
}

// ── ADMIN: login ──
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  res.json({ success: password === process.env.ADMIN_PASSWORD });
});

// ── ADMIN: start round ──
app.post('/api/admin/start-round', (req, res) => {
  const { imageUrl, correctDirection, newPrice, round } = req.body;
  gameState.currentRound = parseInt(round);
  gameState.currentImage = imageUrl;
  gameState.correctDirection = correctDirection;
  gameState.currentPrice = parseFloat(newPrice);
  gameState.timerActive = true;
  gameState.gameActive = true;

  setTimeout(() => {
    gameState.timerActive = false;
  }, 30000);

  res.json({ success: true, gameState });
});

// ── ADMIN: end round ──
app.post('/api/admin/end-round', async (req, res) => {
  const { newPrice } = req.body;
  const price = parseFloat(newPrice);
  gameState.currentPrice = price;
  gameState.timerActive = false;

  // Calculate PnL for all participants
  Object.values(participants).forEach(p => {
    if (p.units === 0 || p.position === 'FLAT') return;
    let roundPnl = 0;
    if (p.position === 'BUY') roundPnl = (price - p.entryPrice) * p.units;
    else if (p.position === 'SELL') roundPnl = (p.entryPrice - price) * p.units;
    p.cash = p.cash + (p.units * price);
    p.totalPnl += roundPnl;
    p.position = 'FLAT';
    p.units = 0;
    p.entryPrice = 0;
  });

  // Sync all to sheet after round ends
  await syncAllToSheet();

  res.json({ success: true, newPrice: price });
});

// ── ADMIN: get all participants ──
app.get('/api/admin/participants', (req, res) => {
  res.json(Object.values(participants));
});

// ── PARTICIPANT: register ──
// Race condition prevention: one registration per name (case-insensitive)
app.post('/api/participant/register', async (req, res) => {
  const { name, email } = req.body;
  if (!name || name.trim() === '') return res.json({ success: false, message: 'Enter your name' });
  if (!email || !email.includes('@')) return res.json({ success: false, message: 'Enter a valid email' });

  // Unique key = name + email (both lowercase, trimmed)
  const key = (name.trim() + '|' + email.trim()).toLowerCase();

  // If already registered — return same session (handles duplicate device)
  if (participants[key]) {
    const p = participants[key];
    return res.json({
      success: true,
      participantId: p.id,
      name: p.name,
      cashBalance: p.cash,
      totalPnl: p.totalPnl,
      rejoined: true
    });
  }

  // New registration
  const id = 'P' + Date.now();
  const p = {
    id,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    cash: 10000,
    position: 'FLAT',
    units: 0,
    entryPrice: 0,
    totalPnl: 0,
    round: 0,
    registeredAt: new Date().toISOString()
  };

  participants[key] = p;

  // Sync to sheet in background
  syncParticipantToSheet(p);

  res.json({ success: true, participantId: id, name: p.name, cashBalance: 10000, totalPnl: 0 });
});

// ── PARTICIPANT: game state ──
app.get('/api/game-state', (req, res) => {
  res.json(gameState);
});

// ── PARTICIPANT: submit order ──
app.post('/api/participant/order', async (req, res) => {
  const { participantId, direction, units } = req.body;
  const u = parseInt(units);

  if (!gameState.timerActive) {
    return res.json({ success: false, message: 'Round closed' });
  }
  if (u < 1 || u > 20) {
    return res.json({ success: false, message: 'Units must be 1-20' });
  }

  // Find participant by id
  const p = Object.values(participants).find(x => x.id === participantId);
  if (!p) {
    return res.json({ success: false, message: 'Participant not found' });
  }

  const orderValue = u * gameState.currentPrice;
  if (orderValue > p.cash) {
    return res.json({ success: false, message: 'Insufficient balance' });
  }

  // Place order
  p.cash -= orderValue;
  p.position = direction;
  p.units = u;
  p.entryPrice = gameState.currentPrice;
  p.round = gameState.currentRound;

  res.json({ success: true, newBalance: p.cash });
});

// ── LEADERBOARD ──
app.get('/api/leaderboard', (req, res) => {
  const board = Object.values(participants)
    .map(p => ({ name: p.name, totalPnl: p.totalPnl, cash: p.cash }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
  res.json(board);
});

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
