const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Labyrinth-Parameter
const CELL_SIZE = 40;
let COLS = Math.floor(1920 / CELL_SIZE) - 1; // <--- HIER -1 !
let ROWS = Math.floor(1080 / CELL_SIZE);     // Zeilen bleiben gleich
// NICHTS abziehen!
let maze = generateMaze(COLS, ROWS);
const players = [];
let gameLocked = false; // Wenn true, kann keiner mehr joinen
let ghosts = []; // Array für Geister
let deadPlayers = []; // Array für tote Spieler
let powerups = [];
const powerupTypes = ['ghost_hidden', 'player_hidden', 'frozen_ghost'];

// Spiel-Status-Variablen
let gameStartTime = null;
let gameEndTime = null;
let gameResult = null;
let gameInterval = null;

// Labyrinth-Generator (Depth-First Search)
function generateMaze(cols, rows) {
    // 1. Initialisiere alles mit Wand
    let maze = Array.from({ length: rows }, () => Array(cols).fill(0));

    // 2. Nur das Innere wird bearbeitet (Rand bleibt Wand)
    function carve(x, y) {
        maze[y][x] = 1;
        const dirs = [
            [0, -2], [2, 0], [0, 2], [-2, 0]
        ].sort(() => Math.random() - 0.5);

        for (const [dx, dy] of dirs) {
            const nx = x + dx;
            const ny = y + dy;
            if (
                nx > 0 && nx < cols - 1 &&
                ny > 0 && ny < rows - 1 &&
                maze[ny][nx] === 0
            ) {
                maze[y + dy / 2][x + dx / 2] = 1;
                carve(nx, ny);
            }
        }
    }

    carve(1, 1);

    // ENTFERNE den Block, der die rechte Wand nochmal setzt!

    return maze;
}

function getGhostCount(playerCount) {
    return Math.ceil(playerCount / 10);
}

app.get('/maze', (req, res) => {
    res.json({ maze, cols: COLS, rows: ROWS, cellSize: CELL_SIZE });
});

function getFreeFields() {
    const freeFields = [];
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            if (maze[y][x] === 1) {
                freeFields.push({ x, y });
            }
        }
    }
    return freeFields;
}

app.get('/join', (req, res) => {
    // Join ist immer erlaubt
        const name = (req.query.name || '').trim().substring(0,16) || 'Spieler';
        // Prüfe, ob Spieler mit diesem Namen schon existiert (Case-insensitive)
        let existing = players.find(p => p.name && p.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            // Spieler übernehmen (ID bleibt gleich, Position etc. bleiben erhalten)
            return res.json({ playerId: existing.id });
        }
        // Neuer Spieler
        const playerId = Date.now().toString(36) + Math.random().toString(36);

    // Suche alle freien Felder (maze[y][x] === 1)

    if (getFreeFields().length === 0) {
        return res.status(500).json({ error: 'Kein freier Platz im Labyrinth!' });
    }

    const start = getFreeFields()[Math.floor(Math.random() * getFreeFields().length)];

    // Jeder 11., 21., ... Spieler ist sofort ein Geist
    let isGhost = false;
    const numPlayers = players.length + 1;
    if (numPlayers % 10 === 1 && numPlayers > 1) {
        isGhost = true;
        ghosts.push(playerId);
    }

    players.push({ id: playerId, x: start.x, y: start.y, alive: true, isGhost, lastKill: 0, name, activatePowerups: [] });
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
                    liveTime: (p.deathTime ? p.deathTime : Date.now()) - gameStartTime,
                    kills: 0 // Spieler haben immer 0 kills!
                })),
                winner: (() => {
                    // Jeder 2 Minuten überlebte Zeit zählt wie ein "Kill" für die Auswertung des Gewinners,
                    // aber NICHT für die Anzeige der Kills!
                    const maxSurvive = Math.max(...players.filter(p => !p.isGhost).map(p =>
                        (p.deathTime ? p.deathTime : Date.now()) - gameStartTime
                    ), 0);
                    // Wenn ein Spieler mindestens 2 Minuten überlebt hat, gewinnen die Überlebenden
                    if (maxSurvive >= 2 * 60 * 1000) return 'Überlebende';
                    return alivePlayers.length === 0 ? 'Geister' : 'Überlebende';
                })()
            };
            setTimeout(resetGame, 10 * 1000); // Nach 10 Sekunden resetten
            clearInterval(gameInterval);
        }
    }, 1000);
}

// Spiel zurücksetzen
function resetGame() {
    maze = generateMaze(COLS, ROWS);

    const freeFields = getFreeFields();

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

    // Erste Power setzen
    powerups.push({
        type: powerupTypes[Math.floor(Math.random() * powerupTypes.length)],
        x: getFreeFields()[Math.floor(Math.random() * getFreeFields().length)].x,
        y: getFreeFields()[Math.floor(Math.random() * getFreeFields().length)].y,
    });

    // Nur noch fehlende Geister bestimmen (falls durch Join schon welche gesetzt wurden)
    const aktuelleGeister = ghosts.slice();
    const nochZuVergeben = ghostCount - aktuelleGeister.length;
    if (nochZuVergeben > 0) {
        // Wähle zufällig weitere Geister aus
        const candidates = players.filter(p => !p.isGhost);
        const shuffled = candidates.slice().sort(() => Math.random() - 0.5);
        const neueGeister = shuffled.slice(0, nochZuVergeben).map(p => p.id);
        ghosts.push(...neueGeister);
        for (const id of neueGeister) {
            const p = players.find(pl => pl.id === id);
            if (p) p.isGhost = true;
        }
    }
    // Setze isGhost für alle Geister (auch für die, die schon vorher gesetzt wurden)
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
    if (isFrozenGhost() && player.isGhost) return res.status(403).json({ error: 'Geister sind eingefroren!' });

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

    // Powerup einsammeln
    for (let i = 0; i < powerups.length; i++) {
        const pu = powerups[i];
        if (Math.abs(pu.x - player.x) < step && Math.abs(pu.y - player.y) < step) {
            player.activatePowerups.push({ type: pu.type, duration: 20 });
            powerups.splice(i, 1);
            i--;
        }
    }

    res.json({ player });
});

function isFrozenGhost() {
    for (const p of players) {
        for (const ap of p.activatePowerups) {
            if (ap.type === 'frozen_ghost' && ap.duration > 0) {
                return true;
            }
        }
    }
    return false;
}

setInterval(() => {
    for (const p of players) {
        for (const ap of p.activatePowerups) {
            ap.duration--;
            if (ap.duration <= 0) {
                p.activatePowerups = p.activatePowerups.filter(a => a !== ap);
            }
        }
    }
}, 1000);

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
    res.json({ timeLeft, gameLocked, powerups });
});

app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT} or on http://localhost:${PORT}`);
});

// Powerups alle 20 Sekunden erneuern
setInterval(() => {
    if (!gameLocked) return; // Nur wenn Spiel läuft
    // Powerups leeren
    powerups = [];
    const freeFields = getFreeFields();
    // 1 bis 5 neue Powerups erzeugen
    const count = 1 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count && freeFields.length > 0; i++) {
        const idx = Math.floor(Math.random() * freeFields.length);
        const field = freeFields.splice(idx, 1)[0];
        powerups.push({
        type: powerupTypes[Math.floor(Math.random() * powerupTypes.length)],
            x: field.x,
            y: field.y
        });
    }
}, 20000);