const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const database = new DatabaseSync(path.join(ROOT, 'boris.sqlite'));
const SLOT_TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00'];

database.exec(`
  CREATE TABLE IF NOT EXISTS walk_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walk_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    booked_by TEXT,
    booked_at TEXT,
    UNIQUE (walk_date, slot_time),
    CHECK (
      (booked_by IS NULL AND booked_at IS NULL)
      OR (booked_by IS NOT NULL AND booked_at IS NOT NULL)
    )
  );
  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name TEXT NOT NULL,
    fed_at TEXT NOT NULL
  );
`);

function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function ensureSlots(date) {
  const insert = database.prepare('INSERT OR IGNORE INTO walk_slots (walk_date, slot_time) VALUES (?, ?)');
  for (const time of SLOT_TIMES) insert.run(date, time);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function isFullName(value) {
  const parts = value.trim().split(/\s+/u);
  return parts.length >= 2 && parts.every(part => /^[\p{L}]+(?:[-'’][\p{L}]+)*$/u.test(part));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('Слишком большой запрос.');
  }
  return JSON.parse(body || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const date = today();

  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      ensureSlots(date);
      const slots = database.prepare('SELECT slot_time, booked_by, booked_at FROM walk_slots WHERE walk_date = ? ORDER BY slot_time').all(date);
      const feeding = database.prepare('SELECT employee_name, fed_at FROM feedings ORDER BY id DESC LIMIT 1').get() || null;
      return sendJson(res, 200, { date, slots, feeding });
    }

    if (req.method === 'POST' && url.pathname === '/api/book') {
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const slot = typeof body.slot === 'string' ? body.slot : '';
      if (!isFullName(name)) return sendJson(res, 400, { error: 'Введите имя и фамилию, используя буквы.' });
      if (name.length > 120) return sendJson(res, 400, { error: 'ФИО должно быть короче 120 символов.' });
      if (!SLOT_TIMES.includes(slot)) return sendJson(res, 400, { error: 'Выберите корректное время прогулки.' });
      ensureSlots(date);
      const result = database.prepare(`UPDATE walk_slots SET booked_by = ?, booked_at = ?
        WHERE walk_date = ? AND slot_time = ? AND booked_by IS NULL`).run(name, new Date().toISOString(), date, slot);
      if (Number(result.changes) === 0) return sendJson(res, 409, { error: 'Этот слот уже занят. Обновите страницу и выберите свободное время.' });
      return sendJson(res, 201, { message: 'Запись подтверждена.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/feeding') {
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!isFullName(name)) return sendJson(res, 400, { error: 'Введите имя и фамилию, используя буквы.' });
      if (name.length > 120) return sendJson(res, 400, { error: 'ФИО должно быть короче 120 символов.' });
      database.prepare('INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)').run(name, new Date().toISOString());
      return sendJson(res, 201, { message: 'Кормление отмечено.' });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
    }

    sendJson(res, 404, { error: 'Страница не найдена.' });
  } catch (error) {
    sendJson(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'Некорректный запрос.' : 'Не удалось обработать запрос.' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Приложение запущено: http://127.0.0.1:${PORT}`));
