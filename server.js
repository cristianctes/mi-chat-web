const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// FUNCIÓN ACTUALIZADA: Envía el Nombre Y el ID de conexión para evitar el [object Object]
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
        socket.join(data.room);
        socket.username = data.username;
        socket.room = data.room;

        io.to(data.room).emit('chat message', {
            username: "Sistema",
            text: `➡️ ${data.username} ha entrado a la sala.`
        });

        // Enviamos el paquete de datos estructurado como lo pide el nuevo index.html
        io.to(data.room).emit('room users', obtenerUsuariosEnSala(data.room));
    });

    socket.on('chat message', (data) => {
        io.to(data.room).emit('chat message', { username: data.username, text: data.text });
    });

    // LÓGICA DE REDIRECCIÓN PARA MENSAJES PRIVADOS
    socket.on('private message', (data) => {
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

// Puerto dinámico compatible con Render
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Servidor en funcionamiento en el puerto: ${PORT}`);
});
