const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Labyrinth-Parameter
const CELL_SIZE = 40;
const COLS = Math.floor(1920 / CELL_SIZE);
const ROWS = Math.floor(1080 / CELL_SIZE);
let maze = generateMaze(COLS, ROWS);
const players = [];
let gameLocked = false; // Wenn true, kann keiner mehr joinen
let ghosts = []; // Array für Geister
let deadPlayers = []; // Array für tote Spieler

// Spiel-Status-Variablen
let gameStartTime = null;
let gameEndTime = null;
let gameResult = null;
let gameInterval = null;

// Labyrinth-Generator (Depth-First Search)
function generateMaze(cols, rows) {
    let maze = Array.from({ length: rows }, () => Array(cols).fill(0));

    function carve(x, y) {
        maze[y][x] = 1;
        const dirs = [
            [0, -2], [2, 0], [0, 2], [-2, 0]
        ].sort(() => Math.random() - 0.5);

        for (const [dx, dy] of dirs) {
            const nx = x + dx;
            const ny = y + dy;
            if (
                nx > 0 && nx < cols &&
                ny > 0 && ny < rows &&
                maze[ny][nx] === 0
            ) {
                maze[y + dy / 2][x + dx / 2] = 1;
                carve(nx, ny);
            }
        }
    }

    carve(1, 1);
    maze[1][0] = 1; // Eingang links
    maze[rows - 2][cols - 1] = 1; // Ausgang rechts unten

    return maze;
}

function getGhostCount(playerCount) {
    return Math.ceil(playerCount / 10);
}

app.get('/maze', (req, res) => {
    res.json({ maze, cols: COLS, rows: ROWS, cellSize: CELL_SIZE });
});

app.get('/join', (req, res) => {
    if (gameLocked) return res.status(403).json({ error: 'Kein Join mehr möglich!' });

    const playerId = Date.now().toString(36) + Math.random().toString(36);

    // Suche alle freien Felder (maze[y][x] === 1)
    const freeFields = [];
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            if (maze[y][x] === 1) {
                freeFields.push({ x, y });
            }
        }
    }

    if (freeFields.length === 0) {
        return res.status(500).json({ error: 'Kein freier Platz im Labyrinth!' });
    }

    const start = freeFields[Math.floor(Math.random() * freeFields.length)];

    players.push({ id: playerId, x: start.x, y: start.y, alive: true, isGhost: false, lastKill: 0 });
    res.json({ playerId });
});

// Spiel-Timer starten
function startGameTimer() {
    gameStartTime = Date.now();
    gameEndTime = null;
    gameResult = null;

    if (gameInterval) clearInterval(gameInterval);

    gameInterval = setInterval(() => {
        // Prüfe ob Spiel vorbei ist
        const alivePlayers = players.filter(p => p.alive && !p.isGhost);
        const aliveGhosts = players.filter(p => p.alive && p.isGhost);

        // Wenn alle normalen Spieler tot sind oder Zeit abgelaufen ist
        if (alivePlayers.length === 0 || Date.now() - gameStartTime > 10 * 60 * 1000) {
            gameEndTime = Date.now();
            // Auswertung vorbereiten
            gameResult = {
                ghosts: ghosts.map(id => {
                    const g = players.find(p => p.id === id);
                    return {
                        id,
                        kills: players.filter(p => p.killedBy === id).length
                    };
                }),
                survivors: players.filter(p => !p.isGhost).map(p => ({
                    id: p.id,
                    liveTime: (p.deathTime ? p.deathTime : Date.now()) - gameStartTime
                })),
                winner: alivePlayers.length === 0 ? 'Geister' : 'Überlebende'
            };
            setTimeout(resetGame, 10 * 1000); // Nach 10 Sekunden resetten
            clearInterval(gameInterval);
        }
    }, 1000);
}

// Spiel zurücksetzen
function resetGame() {
    maze = generateMaze(COLS, ROWS);

    const freeFields = [];
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            if (maze[y][x] === 1) {
                freeFields.push({ x, y });
            }
        }
    }

    for (const p of players) {
        const start = freeFields[Math.floor(Math.random() * freeFields.length)];
        p.x = start.x;
        p.y = start.y;
        p.alive = true;
        p.isGhost = false;
        p.deathTime = null;
        p.killedBy = null;
    }

    ghosts = [];
    deadPlayers = [];
    gameLocked = false;
    gameStartTime = null;
    gameEndTime = null;
    gameResult = null;
}

// Button-Route: Spiel sperren und Geister bestimmen
app.post('/lock', (req, res) => {
    if (gameLocked) return res.status(400).json({ error: 'Bereits gesperrt!' });
    if (players.length < 2) return res.status(400).json({ error: 'Mindestens 2 Spieler!' });

    gameLocked = true;
    const ghostCount = getGhostCount(players.length);

    // Zufällig Geister auswählen
    const shuffled = players.slice().sort(() => Math.random() - 0.5);
    ghosts = shuffled.slice(0, ghostCount).map(p => p.id);

    for (const player of players) {
        if (ghosts.includes(player.id)) player.isGhost = true;
    }

    startGameTimer();

    res.json({ ghosts });
});

// Geister können töten, Kills werden gezählt
app.get('/move', (req, res) => {
    const { dir, id } = req.query;
    const player = players.find(p => p.id === id);
    if (!player) return res.status(400).json({ error: 'Invalid player ID' });
    if (!player.alive) return res.status(403).json({ error: 'Du bist tot!' });

    // Schrittweite
    const step = 1;
    let targetX = player.x;
    let targetY = player.y;

    if (dir === "up") targetY -= step;
    else if (dir === "down") targetY += step;
    else if (dir === "left") targetX -= step;
    else if (dir === "right") targetX += step;

    // Prüfe, ob alle betroffenen Zellen frei sind
    function isFree(x, y) {
        const minX = Math.floor(x);
        const maxX = Math.ceil(x);
        const minY = Math.floor(y);
        const maxY = Math.ceil(y);

        for (let cx = minX; cx <= maxX; cx++) {
            for (let cy = minY; cy <= maxY; cy++) {
                if (
                    cy < 0 || cy >= ROWS ||
                    cx < 0 || cx >= COLS ||
                    maze[cy][cx] !== 1
                ) {
                    return false;
                }
            }
        }
        return true;
    }

    if (isFree(targetX, targetY)) {
        player.x = targetX;
        player.y = targetY;
    }

    // Geister können töten
    if (player.isGhost) {
        const victim = players.find(p => Math.abs(p.x - player.x) < step && Math.abs(p.y - player.y) < step && p.alive && !p.isGhost && p.id !== player.id);
        if (victim) {
            victim.alive = false;
            victim.deathTime = Date.now();
            victim.killedBy = player.id;
            deadPlayers.push(victim);
        }
    }

    res.json({ player });
});



// API für alle Spieler inkl. Status
app.get('/players', (req, res) => {
    res.json({ players, gameLocked });
});

// API für Auswertung
app.get('/result', (req, res) => {
    if (!gameResult) return res.json({ running: true });
    res.json({ running: false, result: gameResult });
});

app.get('/status', (req, res) => {
    let timeLeft = 0;
    if (gameStartTime) {
        const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
        timeLeft = Math.max(0, 10 * 60 - elapsed);
    } else {
        timeLeft = 10 * 60;
    }
    res.json({ timeLeft, gameLocked });
});

app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});
