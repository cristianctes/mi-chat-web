const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6e6, pingTimeout: 120000, pingInterval: 25000 });
const PORT = process.env.PORT || 3000;
const CHANNELS = ['Chaco-Corrientes','Rosario','Amistades','Musica','Religion','IA','Gay','Parejas'];
const forbidden = (process.env.PALABRAS_PROHIBIDAS || 'palabraprohibida').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const banMs = (Number(process.env.BAN_MINUTOS) || 60) * 60000;
const bans = new Map();
const users = new Map();

app.use(express.static(__dirname));
app.get('/health', (_req,res) => res.json({ok:true}));

function safeNick(value) { return String(value || '').trim().replace(/[<>]/g,'').slice(0,24); }
function safeChannel(value) { return CHANNELS.includes(value) ? value : CHANNELS[0]; }
function ipOf(socket) { return socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address; }
function hasForbidden(text) { const s = String(text || '').toLowerCase(); return forbidden.some(w => s.includes(w)); }
function channelUsers(channel) { return [...users.entries()].filter(([,u]) => u.channel === channel).map(([id,u]) => ({id,nick:u.nick,color:u.color})); }
function publishUsers(channel) { io.to(`channel:${channel}`).emit('users', channelUsers(channel)); }
function system(channel,text) { io.to(`channel:${channel}`).emit('system',{channel,text,time:Date.now()}); }
function validateImage(image) { return !image || (typeof image === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(image) && image.length <= 5.8e6); }
function ban(socket) { const ip=ipOf(socket); bans.set(ip,Date.now()+banMs); socket.emit('banned',{minutes:Math.round(banMs/60000)}); socket.disconnect(true); }

io.use((socket,next) => { const until=bans.get(ipOf(socket))||0; if(until>Date.now()) return next(new Error(`Baneado hasta ${new Date(until).toLocaleString()}`)); if(until) bans.delete(ipOf(socket)); next(); });
io.on('connection', socket => {
  socket.on('join', ({nick,channel,color}={}) => {
    nick=safeNick(nick); if(!nick) return socket.emit('errorMessage','Ingresá un nick.');
    if([...users.values()].some(u => u.nick.toLowerCase()===nick.toLowerCase() && u.socketId!==socket.id)) return socket.emit('errorMessage','Ese nick ya está en uso.');
    channel=safeChannel(channel); color=/^#[0-9a-f]{6}$/i.test(color||'')?color:'#1769aa';
    users.set(socket.id,{socketId:socket.id,nick,channel,color}); socket.join(`channel:${channel}`);
    socket.emit('joined',{id:socket.id,nick,channel,channels:CHANNELS}); system(channel,`➡️ ${nick} ha entrado a la sala.`); publishUsers(channel);
  });
  socket.on('switchChannel', value => {
    const u=users.get(socket.id); if(!u) return; const next=safeChannel(value); if(next===u.channel) return;
    const old=u.channel; socket.leave(`channel:${old}`); system(old,`⬅️ ${u.nick} ha abandonado la sala.`); publishUsers(old);
    u.channel=next; socket.join(`channel:${next}`); socket.emit('channelChanged',{channel:next}); system(next,`➡️ ${u.nick} ha entrado a la sala.`); publishUsers(next);
  });
  socket.on('channelMessage', ({text,image}={}) => {
    const u=users.get(socket.id); if(!u || (!String(text||'').trim()&&!image)) return; if(hasForbidden(text)) return ban(socket); if(!validateImage(image)) return socket.emit('errorMessage','Imagen inválida o mayor a 5 MB.');
    io.to(`channel:${u.channel}`).emit('channelMessage',{fromId:socket.id,nick:u.nick,color:u.color,channel:u.channel,text:String(text||'').trim().slice(0,1000),image:image||null,time:Date.now()});
  });
  socket.on('privateMessage', ({to,text,image}={}) => {
    const u=users.get(socket.id), target=users.get(to); if(!u||!target||(!String(text||'').trim()&&!image)) return; if(hasForbidden(text)) return ban(socket); if(!validateImage(image)) return socket.emit('errorMessage','Imagen inválida o mayor a 5 MB.');
    const msg={fromId:socket.id,toId:to,nick:u.nick,color:u.color,text:String(text||'').trim().slice(0,1000),image:image||null,time:Date.now()}; io.to(socket.id).to(to).emit('privateMessage',msg);
  });
  socket.on('disconnect', () => { const u=users.get(socket.id); if(!u)return; users.delete(socket.id); system(u.channel,`⬅️ ${u.nick} ha abandonado la sala.`); publishUsers(u.channel); io.emit('userLeft',{id:socket.id,nick:u.nick}); });
});
server.listen(PORT,()=>console.log(`Chat listo en puerto ${PORT}`));
