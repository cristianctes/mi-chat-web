const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Función auxiliar para obtener la lista de nombres de una sala específica
function obtenerUsuariosEnSala(sala) {
    const usuarios = [];
    const clientes = io.sockets.adapter.rooms.get(sala);
    if (clientes) {
        for (const clientId of clientes) {
            const clientSocket = io.sockets.sockets.get(clientId);
            if (clientSocket && clientSocket.username) {
                usuarios.push(clientSocket.username);
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

        console.log(`${data.username} se unió a: ${data.room}`);

        io.to(data.room).emit('chat message', {
            username: "Sistema",
            text: `➡️ ${data.username} ha entrado a la sala.`
        });

        // Enviar la lista de usuarios actualizada a todos los de esa sala
        io.to(data.room).emit('room users', obtenerUsuariosEnSala(data.room));
    });

    socket.on('chat message', (data) => {
        io.to(data.room).emit('chat message', {
            username: data.username,
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

            // Enviar la lista actualizada (recalculada sin el usuario que se fue)
            io.to(salaDondeEstaba).emit('room users', obtenerUsuariosEnSala(salaDondeEstaba));
        }
    });
});

// Render define automáticamente la variable PROCESS.ENV.PORT
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Servidor funcionando en el puerto: ${PORT}`);
});
