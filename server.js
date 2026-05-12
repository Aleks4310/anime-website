const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Подключаем базу данных
const db = new Database('anime.db');

// Создаём таблицы при запуске
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(100) NOT NULL UNIQUE,
        password CHAR(64) NOT NULL,
        avatar VARCHAR(500) DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        anime_id INTEGER NOT NULL,
        anime_title VARCHAR(200) NOT NULL,
        anime_image VARCHAR(500) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
`);

const JIKAN = 'https://api.jikan.moe/v4';

// Функция хеширования пароля
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Middleware для проверки авторизации
function authMiddleware(req, res, next) {
    const userId = req.headers['user-id'];
    if (!userId) return res.status(401).json({ error: 'Не авторизован' });
    const user = db.prepare('SELECT id, username, email, avatar FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = user;
    next();
}

// ===== KODIK API (через Python прокси) =====

app.get('/api/kodik/search', async (req, res) => {
    try {
        const { title, shikimori_id } = req.query;
        const params = new URLSearchParams();
        if (title) params.append('title', title);
        if (shikimori_id) params.append('shikimori_id', shikimori_id);
        
        const KODIK_PROXY = process.env.KODIK_PROXY_URL || 'http://localhost:5000';
        const response = await fetch(`${KODIK_PROXY}/api/kodik/search?${params}`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Ошибка Kodik:', error.message);
        res.json({ results: [] });
    }
});

// === АВТОРИЗАЦИЯ ===

app.post('/api/auth/register', (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Все поля обязательны' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
    
    try {
        const hashedPassword = hashPassword(password);
        const result = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hashedPassword);
        const user = db.prepare('SELECT id, username, email, avatar FROM users WHERE id = ?').get(result.lastInsertRowid);
        res.json({ success: true, user });
    } catch (error) {
        if (error.message.includes('UNIQUE')) {
            const field = error.message.includes('username') ? 'Имя пользователя' : 'Email';
            return res.status(400).json({ error: `${field} уже занят` });
        }
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    
    const hashedPassword = hashPassword(password);
    const user = db.prepare('SELECT id, username, email, avatar FROM users WHERE email = ? AND password = ?').get(email, hashedPassword);
    
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    res.json({ success: true, user });
});

app.post('/api/auth/avatar', authMiddleware, (req, res) => {
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(req.body.avatar, req.user.id);
    res.json({ success: true });
});

app.get('/api/auth/profile', authMiddleware, (req, res) => {
    const favCount = db.prepare('SELECT COUNT(*) as count FROM favorites WHERE user_id = ?').get(req.user.id);
    res.json({ user: req.user, favCount: favCount.count });
});

// === ИЗБРАННОЕ ===

app.get('/api/favorites', authMiddleware, (req, res) => {
    const favorites = db.prepare('SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ data: favorites });
});

app.post('/api/favorites', authMiddleware, (req, res) => {
    const { anime_id, anime_title, anime_image } = req.body;
    const exists = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND anime_id = ?').get(req.user.id, anime_id);
    
    if (exists) {
        db.prepare('DELETE FROM favorites WHERE id = ?').run(exists.id);
        res.json({ success: true, action: 'removed' });
    } else {
        db.prepare('INSERT INTO favorites (user_id, anime_id, anime_title, anime_image) VALUES (?, ?, ?, ?)').run(req.user.id, anime_id, anime_title, anime_image);
        res.json({ success: true, action: 'added' });
    }
});

// === АНИМЕ ===

app.get('/api/anime/popular', async (req, res) => {
    try {
        const page = req.query.page || 1;
        const response = await fetch(`${JIKAN}/top/anime?page=${page}&limit=24`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/anime/season', async (req, res) => {
    try {
        const page = req.query.page || 1;
        const response = await fetch(`${JIKAN}/seasons/now?page=${page}&limit=24`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/anime/season/:year/:season', async (req, res) => {
    try {
        const { year, season } = req.params;
        const page = req.query.page || 1;
        const response = await fetch(`${JIKAN}/seasons/${year}/${season}?page=${page}&limit=24`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/anime/search', async (req, res) => {
    try {
        const query = req.query.q || '';
        const page = req.query.page || 1;
        if (!query) return res.json({ data: [] });
        const response = await fetch(`${JIKAN}/anime?q=${encodeURIComponent(query)}&page=${page}&limit=24`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/anime/genre/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const page = req.query.page || 1;
        const response = await fetch(`${JIKAN}/anime?genres=${id}&page=${page}&limit=24&order_by=score&sort=desc`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/anime/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const response = await fetch(`${JIKAN}/anime/${id}/full`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/genres', async (req, res) => {
    try {
        const response = await fetch(`${JIKAN}/genres/anime`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/random/anime', async (req, res) => {
    try {
        const response = await fetch(`${JIKAN}/random/anime`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/test', (req, res) => {
    res.json({ status: 'ok', db: 'SQLite' });
});

const path = require('path');
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log('=========================================');
    console.log(`🚀 Сервер на http://localhost:${PORT}`);
    console.log('📡 Jikan API + SQLite + Kodik (Python)');
    console.log('=========================================');
});