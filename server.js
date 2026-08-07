const express = require('express');
const multer = require('multer');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// La clave de imgbb vive SOLO en el servidor (variable de entorno), nunca en el navegador.
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// Palabras prohibidas configurables desde Render > Environment.
// Ejemplo: PALABRAS_PROHIBIDAS=palabra1,palabra2,frase prohibida
const PALABRAS_PROHIBIDAS = (process.env.PALABRAS_PROHIBIDAS || 'palabraprohibida')
    .split(',')
    .map(p => normalizarTexto(p))
    .filter(Boolean);

// Duración del baneo por IP. Por defecto: 60 minutos.
const BAN_MINUTOS = Math.max(1, Number(process.env.BAN_MINUTOS || 60));
const baneosPorIp = new Map(); // ip -> timestamp de vencimiento

function normalizarTexto(texto = '') {
    return String(texto)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9ñ]+/gi, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function contienePalabraProhibida(texto = '') {
    const limpio = ` ${normalizarTexto(texto)} `;
    return PALABRAS_PROHIBIDAS.find(palabra => limpio.includes(` ${palabra} `)) || null;
}

function obtenerIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return socket.handshake.address || 'desconocida';
}

function ipEstaBaneada(ip) {
    const vence = baneosPorIp.get(ip);
    if (!vence) return false;
    if (Date.now() >= vence) {
        baneosPorIp.delete(ip);
        return false;
    }
    return true;
}

function aplicarBan(socket, palabraDetectada) {
    const ip = obtenerIp(socket);
    const vence = Date.now() + BAN_MINUTOS * 60 * 1000;
    socket.wasBanned = true;
    baneosPorIp.set(ip, vence);

    if (socket.room && socket.username) {
        io.to(socket.room).emit('chat message', {
            username: 'Sistema',
            text: `⛔ ${socket.username} fue expulsado por usar lenguaje prohibido.`
        });
    }

    socket.emit('banned', {
        reason: 'Usaste una palabra prohibida.',
        minutes: BAN_MINUTOS,
        detected: palabraDetectada
    });

    setTimeout(() => socket.disconnect(true), 150);
}

// Guarda el archivo subido en memoria (no en disco) para reenviarlo a imgbb.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB máximo por imagen
    fileFilter: (req, file, cb) => {
        const permitidos = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!permitidos.includes(file.mimetype)) {
            return cb(new Error('Solo se permiten imágenes JPG, PNG, GIF o WEBP.'));
        }
        cb(null, true);
    }
});

// Validación simple de la firma real del archivo para evitar archivos disfrazados de imagen.
function esImagenReal(buffer) {
    if (!buffer || buffer.length < 12) return false;

    const jpg = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    const png = buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    const gif = buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a';
    const webp = buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';

    return jpg || png || gif || webp;
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// RUTA PROXY: el navegador manda la imagen acá y el servidor la reenvía a imgbb.
app.post('/upload', (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ success: false, error: err.message || 'Archivo no válido.' });
        }

        try {
            if (!IMGBB_API_KEY) {
                return res.status(500).json({ success: false, error: 'Falta configurar IMGBB_API_KEY en el servidor.' });
            }
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'No se recibió ninguna imagen.' });
            }
            if (!esImagenReal(req.file.buffer)) {
                return res.status(400).json({ success: false, error: 'El archivo seleccionado no es una imagen válida.' });
            }

            const base64Imagen = req.file.buffer.toString('base64');
            const formData = new FormData();
            formData.append('key', IMGBB_API_KEY);
            formData.append('image', base64Imagen);

            const respuestaImgbb = await fetch('https://api.imgbb.com/1/upload', {
                method: 'POST',
                body: formData
            });
            const datos = await respuestaImgbb.json();

            if (!datos.success) {
                return res.status(502).json({ success: false, error: 'imgbb rechazó la imagen.' });
            }

            res.json({ success: true, url: datos.data.url });
        } catch (error) {
            console.error('Error subiendo imagen:', error);
            res.status(500).json({ success: false, error: 'Error interno subiendo la imagen.' });
        }
    });
});

function obtenerUsuariosEnSala(sala) {
    const usuarios = [];
    const clientes = io.sockets.adapter.rooms.get(sala);
    if (clientes) {
        for (const clientId of clientes) {
            const clientSocket = io.sockets.sockets.get(clientId);
            if (clientSocket && clientSocket.username) {
                usuarios.push({
                    username: clientSocket.username,
                    id: clientSocket.id
                });
            }
        }
    }
    return usuarios;
}

io.on('connection', (socket) => {
    const ip = obtenerIp(socket);

    if (ipEstaBaneada(ip)) {
        socket.emit('banned', {
            reason: 'Tu acceso está temporalmente bloqueado.',
            minutes: BAN_MINUTOS
        });
        return setTimeout(() => socket.disconnect(true), 150);
    }

    socket.on('join room', (data) => {
        if (!data || !data.username || !data.room) return;

        if (ipEstaBaneada(obtenerIp(socket))) {
            socket.emit('banned', { reason: 'Tu acceso está temporalmente bloqueado.', minutes: BAN_MINUTOS });
            return setTimeout(() => socket.disconnect(true), 150);
        }

        const nombreLimpio = String(data.username).trim().slice(0, 20);
        const salaLimpia = String(data.room).trim().slice(0, 40);
        if (!nombreLimpio || !salaLimpia) return;

        socket.join(salaLimpia);
        socket.username = nombreLimpio;
        socket.room = salaLimpia;

        io.to(salaLimpia).emit('chat message', {
            username: 'Sistema',
            text: `➡️ ${nombreLimpio} ha entrado a la sala.`
        });

        io.to(salaLimpia).emit('room users', obtenerUsuariosEnSala(salaLimpia));
    });

    socket.on('chat message', (data) => {
        if (!socket.username || !socket.room || !data || !data.text || !String(data.text).trim()) return;

        const textoLimpio = String(data.text).trim().slice(0, 500);
        const prohibida = contienePalabraProhibida(textoLimpio);
        if (prohibida) return aplicarBan(socket, prohibida);

        io.to(socket.room).emit('chat message', {
            username: socket.username,
            userId: socket.id,
            text: textoLimpio
        });
    });

    // MENSAJES PRIVADOS DIRECTOS, incluyendo links de imágenes subidas por /upload.
    socket.on('private message', (data) => {
        if (!socket.username || !data || !data.to || !data.text || !String(data.text).trim()) return;

        const textoLimpio = String(data.text).trim().slice(0, 500);
        const prohibida = contienePalabraProhibida(textoLimpio);
        if (prohibida) return aplicarBan(socket, prohibida);

        const destino = io.sockets.sockets.get(data.to);
        if (!destino || destino.room !== socket.room) {
            return socket.emit('private unavailable', {
                to: data.to,
                username: data.toUsername || 'El usuario'
            });
        }

        io.to(data.to).emit('private message', {
            from: socket.username,
            fromId: socket.id,
            text: textoLimpio
        });
    });

    socket.on('disconnect', () => {
        if (socket.username && socket.room) {
            const salaDondeEstaba = socket.room;

            if (!socket.wasBanned) {
                io.to(salaDondeEstaba).emit('chat message', {
                    username: 'Sistema',
                    text: `⬅️ ${socket.username} ha abandonado la sala.`
                });
            }

            // Aviso específico para que los privados abiertos sepan que esa persona ya no está.
            io.to(salaDondeEstaba).emit('user left', {
                id: socket.id,
                username: socket.username
            });

            io.to(salaDondeEstaba).emit('room users', obtenerUsuariosEnSala(salaDondeEstaba));
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Servidor funcionando en el puerto: ${PORT}`);
});
