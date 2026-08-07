const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
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
        // Envia el mensaje únicamente al socket de destino
        io.to(data.to).emit('private message', {
            from: data.from,
            fromId: socket.id,
            text: data.text
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
