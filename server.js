const express = require('express');
const multer = require('multer');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// La clave de imgbb vive SOLO en el servidor (variable de entorno), nunca en el navegador
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// Guarda el archivo subido en memoria (no en disco) para reenviarlo a imgbb
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5 MB máximo por imagen
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// RUTA PROXY: el navegador manda la imagen acá, el server la reenvía a imgbb con la key oculta
app.post('/upload', upload.single('image'), async (req, res) => {
    try {
        if (!IMGBB_API_KEY) {
            return res.status(500).json({ success: false, error: 'Falta configurar IMGBB_API_KEY en el servidor.' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No se recibió ninguna imagen.' });
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
    } catch (err) {
        console.error('Error subiendo imagen:', err);
        res.status(500).json({ success: false, error: 'Error interno subiendo la imagen.' });
    }
});

// Ahora guarda el Nombre Y el ID de red de cada usuario
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
    
    socket.on('join room', (data) => {
        if (!data || !data.username || !data.room) return;
        const nombreLimpio = String(data.username).trim().slice(0, 20);
        if (!nombreLimpio) return;

        socket.join(data.room);
        socket.username = nombreLimpio;
        socket.room = data.room;

        io.to(data.room).emit('chat message', {
            username: "Sistema",
            text: `➡️ ${data.username} ha entrado a la sala.`
        });

        io.to(data.room).emit('room users', obtenerUsuariosEnSala(data.room));
    });

    socket.on('chat message', (data) => {
        if (!data || !data.room || !data.text || !String(data.text).trim()) return;
        const textoLimpio = String(data.text).trim().slice(0, 500);
        io.to(data.room).emit('chat message', { username: socket.username || data.username, text: textoLimpio });
    });

    // LÓGICA PARA MENSAJES PRIVADOS DIRECTOS
    socket.on('private message', (data) => {
        if (!data || !data.to || !data.text || !String(data.text).trim()) return;
        const textoLimpio = String(data.text).trim().slice(0, 500);
        // Envia el mensaje únicamente al socket de destino
        io.to(data.to).emit('private message', {
            from: socket.username || data.from,
            fromId: socket.id,
            text: textoLimpio
        });
    });

    socket.on('disconnect', () => {
        if (socket.username && socket.room) {
            const salaDondeEstaba = socket.room;
            io.to(salaDondeEstaba).emit('chat message', {
                username: "Sistema",
                text: `⬅️ ${socket.username} ha salido de la sala.`
            });
            io.to(salaDondeEstaba).emit('room users', obtenerUsuariosEnSala(salaDondeEstaba));
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Servidor funcionando en el puerto: ${PORT}`);
});
