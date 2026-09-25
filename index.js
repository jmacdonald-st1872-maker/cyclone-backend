import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const db = new Database('cyclone.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    avatar TEXT DEFAULT '🧑‍💻',
    private INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    authorId TEXT NOT NULL,
    topic TEXT,
    content TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(authorId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id TEXT PRIMARY KEY,
    postId TEXT NOT NULL,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(postId) REFERENCES posts(id),
    FOREIGN KEY(userId) REFERENCES users(id),
    UNIQUE(postId, userId)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    postId TEXT NOT NULL,
    userId TEXT NOT NULL,
    text TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(postId) REFERENCES posts(id),
    FOREIGN KEY(userId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    followerId TEXT NOT NULL,
    followeeId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(followerId) REFERENCES users(id),
    FOREIGN KEY(followeeId) REFERENCES users(id),
    UNIQUE(followerId, followeeId)
  );

  CREATE TABLE IF NOT EXISTS chessGames (
    id TEXT PRIMARY KEY,
    whiteId TEXT NOT NULL,
    blackId TEXT NOT NULL,
    pgn TEXT,
    result TEXT,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(whiteId) REFERENCES users(id),
    FOREIGN KEY(blackId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS chessRatings (
    userId TEXT PRIMARY KEY,
    rating INTEGER DEFAULT 1200,
    games INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    FOREIGN KEY(userId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    fromId TEXT NOT NULL,
    toId TEXT NOT NULL,
    text TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(fromId) REFERENCES users(id),
    FOREIGN KEY(toId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS liveStreams (
    id TEXT PRIMARY KEY,
    hostId TEXT NOT NULL,
    title TEXT,
    viewers INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(hostId) REFERENCES users(id)
  );
`);

app.post('/auth/register', async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email=? OR username=?').get(email, username);
  if (existing) {
    return res.status(400).json({ error: 'Email or username already taken' });
  }
  const passwordHash = await bcrypt.hash(password, 8);
  const id = uuid();
  db.prepare(`
    INSERT INTO users (id, email, username, passwordHash, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, email, username, passwordHash, Date.now());

  db.prepare(`
    INSERT OR IGNORE INTO chessRatings (userId, rating, games, wins)
    VALUES (?, 1200, 0, 0)
  `).run(id);

  res.json({ id, email, username, avatar: '🧑‍💻', private: false });
});

app.post('/auth/login', async (req, res) => {
  const { identity, password } = req.body;
  if (!identity || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const user = db.prepare(`
    SELECT id, email, username, passwordHash, avatar, private FROM users
    WHERE email = ? OR username = ?
  `).get(identity, identity);
  if (!user) {
    return res.status(401).json({ error: 'No account found' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    private: !!user.private
  });
});

app.get('/users/:id', (req, res) => {
  const u = db.prepare('SELECT id, username, avatar, private FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { followers, following } = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM follows WHERE followeeId = ?) AS followers,
      (SELECT COUNT(*) FROM follows WHERE followerId = ?) AS following
  `).get(u.id, u.id);
  res.json({ ...u, followers, following });
});

app.post('/users/:id/follow', (req, res) => {
  const { followerId } = req.body;
  const followeeId = req.params.id;
  if (followerId === followeeId) return res.status(400).json({ error: 'Cannot follow yourself' });
  const id = uuid();
  try {
    db.prepare(`
      INSERT INTO follows (id, followerId, followeeId, createdAt)
      VALUES (?, ?, ?, ?)
    `).run(id, followerId, followeeId, Date.now());
  } catch {
    return res.status(400).json({ error: 'Already following' });
  }
  res.json({ ok: true });
});

app.get('/posts', (req, res) => {
  const posts = db.prepare(`
    SELECT p.*, u.username AS authorName
    FROM posts p
    JOIN users u ON p.authorId = u.id
    ORDER BY p.createdAt DESC
    LIMIT 100
  `).all();
  const withCounts = posts.map(p => {
    const likes = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE postId=?').get(p.id).c;
    const comments = db.prepare('SELECT COUNT(*) AS c FROM comments WHERE postId=?').get(p.id).c;
    return { ...p, likes, comments };
  });
  res.json(withCounts);
});

app.post('/posts', (req, res) => {
  const { authorId, topic, content } = req.body;
  if (!authorId || !content) return res.status(400).json({ error: 'Missing fields' });
  const id = uuid();
  db.prepare(`
    INSERT INTO posts (id, authorId, topic, content, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, authorId, topic || 'Post', content, Date.now());
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  res.json(post);
});

app.post('/posts/:id/like', (req, res) => {
  const { userId } = req.body;
  const postId = req.params.id;
  const id = uuid();
  try {
    db.prepare(`
      INSERT INTO likes (id, postId, userId, createdAt)
      VALUES (?, ?, ?, ?)
    `).run(id, postId, userId, Date.now());
  } catch {
    return res.status(400).json({ error: 'Already liked' });
  }
  res.json({ ok: true });
});

app.post('/posts/:id/comment', (req, res) => {
  const { userId, text } = req.body;
  const postId = req.params.id;
  if (!text) return res.status(400).json({ error: 'Missing comment' });
  const id = uuid();
  db.prepare(`
    INSERT INTO comments (id, postId, userId, text, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, postId, userId, text, Date.now());
  res.json({ ok: true });
});

io.on('connection', socket => {
  socket.on('join-chess-room', ({ gameId }) => {
    socket.join(`chess:${gameId}`);
  });

  socket.on('chess-move', ({ gameId, move, san }) => {
    io.to(`chess:${gameId}`).emit('chess-move', { gameId, move, san });
  });

  socket.on('chess-game-over', ({ gameId, result }) => {
    io.to(`chess:${gameId}`).emit('chess-game-over', { gameId, result });
  });

  socket.on('disconnect', () => {
    // cleanup if needed
  });
});

app.post('/chess/game', (req, res) => {
  const { whiteId, blackId } = req.body;
  const id = uuid();
  db.prepare(`
    INSERT INTO chessGames (id, whiteId, blackId, createdAt)
    VALUES (?, ?, ?, ?)
  `).run(id, whiteId, blackId, Date.now());
  res.json({ id, whiteId, blackId });
});

function updateRating(userId, win) {
  const row = db.prepare('SELECT rating, games, wins FROM chessRatings WHERE userId=?').get(userId);
  const delta = win ? 15 : -15;
  const newRating = Math.max(400, row.rating + delta);
  db.prepare(`
    UPDATE chessRatings
    SET rating = ?, games = games + 1, wins = wins + ?
    WHERE userId = ?
  `).run(newRating, win ? 1 : 0, userId);
}

app.post('/chess/finish', (req, res) => {
  const { gameId, winnerId } = req.body;
  const game = db.prepare('SELECT * FROM chessGames WHERE id=?').get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  db.prepare('UPDATE chessGames SET result=? WHERE id=?').run(winnerId || 'draw', gameId);
  if (winnerId && winnerId !== 'draw') {
    updateRating(winnerId, true);
    const loserId = winnerId === game.whiteId ? game.blackId : game.whiteId;
    updateRating(loserId, false);
  }
  res.json({ ok: true });
});

app.get('/chess/ratings', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, u.avatar, r.rating, r.games, r.wins
    FROM chessRatings r
    JOIN users u ON r.userId = u.id
    ORDER BY r.rating DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

app.get('/messages/:userId', (req, res) => {
  const userId = req.params.userId;
  const msgs = db.prepare(`
    SELECT * FROM messages
    WHERE fromId = ? OR toId = ?
    ORDER BY createdAt ASC
  `).all(userId, userId);
  res.json(msgs);
});

app.post('/messages', (req, res) => {
  const { fromId, toId, text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });
  const id = uuid();
  db.prepare(`
    INSERT INTO messages (id, fromId, toId, text, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, fromId, toId, Date.now());
  res.json({ ok: true });
});

app.get('/live', (req, res) => {
  const streams = db.prepare(`
    SELECT l.*, u.username AS hostName, u.avatar AS hostAvatar
    FROM liveStreams l
    JOIN users u ON l.hostId = u.id
    WHERE l.active = 1
    ORDER BY l.createdAt DESC
  `).all();
  res.json(streams);
});

app.post('/live', (req, res) => {
  const { hostId, title } = req.body;
  const id = uuid();
  db.prepare(`
    INSERT INTO liveStreams (id, hostId, title, createdAt)
    VALUES (?, ?, ?, ?)
  `).run(id, hostId, title || 'Live', Date.now());
  res.json({ id, hostId, title });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log('Cyclone backend running on port', PORT);
});
