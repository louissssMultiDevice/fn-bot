const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode-terminal');
const { Server } = require('socket.io');
const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Security Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/forexter';
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Error:', err));

// Database Models
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'admin' },
    phone: String,
    telegramChatId: String,
    isActive: { type: Boolean, default: true },
    lastLogin: Date,
    createdAt: { type: Date, default: Date.now }
});

const serverSchema = new mongoose.Schema({
    name: { type: String, required: true },
    address: { type: String, required: true },
    port: { type: Number, required: true },
    type: { type: String, default: 'bedrock' },
    apiEndpoint: String,
    isActive: { type: Boolean, default: true },
    checkInterval: { type: Number, default: 10 },
    lastStatus: Object,
    stats: {
        totalChecks: { type: Number, default: 0 },
        uptimeChecks: { type: Number, default: 0 },
        totalDowntime: { type: Number, default: 0 }
    },
    createdAt: { type: Date, default: Date.now }
});

const incidentSchema = new mongoose.Schema({
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server' },
    type: String,
    title: String,
    description: String,
    severity: { type: String, default: 'info' },
    status: { type: String, default: 'active' },
    resolvedAt: Date,
    data: Object,
    notificationsSent: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const notificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: String,
    title: String,
    message: String,
    recipient: String,
    status: { type: String, default: 'pending' },
    error: String,
    sentAt: Date,
    createdAt: { type: Date, default: Date.now }
});

const settingSchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    value: mongoose.Schema.Types.Mixed,
    description: String,
    updatedAt: { type: Date, default: Date.now }
});

const logSchema = new mongoose.Schema({
    level: { type: String, default: 'info' },
    source: String,
    message: String,
    data: Object,
    ip: String,
    createdAt: { type: Date, default: Date.now }
});

const backupSchema = new mongoose.Schema({
    name: String,
    filename: String,
    size: Number,
    type: String,
    data: Object,
    createdAt: { type: Date, default: Date.now }
});

// Create Models
const User = mongoose.model('User', userSchema);
const ServerModel = mongoose.model('Server', serverSchema);
const Incident = mongoose.model('Incident', incidentSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Setting = mongoose.model('Setting', settingSchema);
const Log = mongoose.model('Log', logSchema);
const Backup = mongoose.model('Backup', backupSchema);

// WhatsApp Client
let whatsappClient = null;
let whatsappReady = false;

// Telegram Bot
let telegramBot = null;
let telegramReady = false;

// Email Transporter
let emailTransporter = null;

// Monitoring System
const monitoringJobs = new Map();

// Utility Functions
async function logEvent(level, source, message, data = {}, ip = 'system') {
    try {
        const log = new Log({
            level,
            source,
            message,
            data,
            ip
        });
        await log.save();
        
        console.log(`[${level.toUpperCase()}] ${source}: ${message}`);
        
        // Emit to socket
        io.emit('log', {
            level,
            source,
            message,
            data,
            timestamp: new Date()
        });
        
        return log;
    } catch (error) {
        console.error('Logging error:', error);
    }
}

async function getSetting(key, defaultValue = null) {
    try {
        const setting = await Setting.findOne({ key });
        return setting ? setting.value : defaultValue;
    } catch (error) {
        console.error('Get setting error:', error);
        return defaultValue;
    }
}

async function setSetting(key, value, description = '') {
    try {
        await Setting.findOneAndUpdate(
            { key },
            { 
                value, 
                description: description || `Setting for ${key}`,
                updatedAt: new Date() 
            },
            { upsert: true, new: true }
        );
        return true;
    } catch (error) {
        console.error('Set setting error:', error);
        return false;
    }
}

// Initialize WhatsApp
async function initializeWhatsApp() {
    try {
        const whatsappEnabled = await getSetting('whatsapp_enabled', false);
        if (!whatsappEnabled) {
            console.log('WhatsApp notifications disabled');
            return;
        }

        whatsappClient = new Client({
            authStrategy: new LocalAuth({
                clientId: "forexter-whatsapp"
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        whatsappClient.on('qr', (qr) => {
            console.log('WhatsApp QR Code:');
            qrcode.generate(qr, { small: true });
            
            // Save QR code to file for web display
            const qrData = qr;
            io.emit('whatsapp-qr', { qr: qrData });
            
            logEvent('info', 'WhatsApp', 'QR Code generated');
        });

        whatsappClient.on('ready', () => {
            console.log('✅ WhatsApp Client is ready!');
            whatsappReady = true;
            io.emit('whatsapp-status', { status: 'connected' });
            logEvent('info', 'WhatsApp', 'Client connected successfully');
        });

        whatsappClient.on('authenticated', () => {
            console.log('✅ WhatsApp authenticated');
            io.emit('whatsapp-status', { status: 'authenticated' });
        });

        whatsappClient.on('auth_failure', (msg) => {
            console.error('❌ WhatsApp auth failure:', msg);
            whatsappReady = false;
            io.emit('whatsapp-status', { status: 'disconnected' });
            logEvent('error', 'WhatsApp', 'Authentication failed: ' + msg);
        });

        whatsappClient.on('disconnected', (reason) => {
            console.log('❌ WhatsApp disconnected:', reason);
            whatsappReady = false;
            io.emit('whatsapp-status', { status: 'disconnected' });
            logEvent('warn', 'WhatsApp', 'Client disconnected: ' + reason);
            
            // Attempt to reconnect
            setTimeout(() => {
                if (!whatsappReady) {
                    console.log('Attempting to reconnect WhatsApp...');
                    whatsappClient.initialize();
                }
            }, 5000);
        });

        await whatsappClient.initialize();
        console.log('WhatsApp client initializing...');
        
    } catch (error) {
        console.error('WhatsApp initialization error:', error);
        logEvent('error', 'WhatsApp', 'Initialization failed: ' + error.message);
    }
}

// Initialize Telegram
async function initializeTelegram() {
    try {
        const telegramEnabled = await getSetting('telegram_enabled', true);
        const botToken = await getSetting('telegram_bot_token');
        
        if (!telegramEnabled || !botToken) {
            console.log('Telegram bot disabled or no token');
            return;
        }

        telegramBot = new TelegramBot(botToken, { polling: true });
        telegramReady = true;

        // Store active chat IDs
        const activeChats = new Set();

        telegramBot.on('polling_error', (error) => {
            console.error('Telegram polling error:', error);
            logEvent('error', 'Telegram', 'Polling error: ' + error.message);
        });

        telegramBot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            const text = msg.text || '';
            const username = msg.from.username || msg.from.first_name;
            
            // Store chat ID
            activeChats.add(chatId);
            await setSetting(`telegram_chat_${chatId}`, {
                username,
                firstName: msg.from.first_name,
                lastName: msg.from.last_name,
                lastActive: new Date()
            });

            // Handle commands
            if (text.startsWith('/')) {
                await handleTelegramCommand(chatId, text, msg);
            }
        });

        console.log('✅ Telegram Bot is ready!');
        logEvent('info', 'Telegram', 'Bot started successfully');
        
    } catch (error) {
        console.error('Telegram initialization error:', error);
        logEvent('error', 'Telegram', 'Initialization failed: ' + error.message);
    }
}

// Handle Telegram Commands
async function handleTelegramCommand(chatId, text, msg) {
    const command = text.split(' ')[0].toLowerCase();
    
    try {
        switch (command) {
            case '/start':
                await telegramBot.sendMessage(chatId, 
                    `🤖 *Forexter Network Bot*\n\n` +
                    `Selamat datang! Bot ini akan mengirim notifikasi ketika server mengalami masalah.\n\n` +
                    `📋 *Perintah yang tersedia:*\n` +
                    `/status - Cek status server saat ini\n` +
                    `/subscribe - Daftar menerima notifikasi\n` +
                    `/unsubscribe - Berhenti notifikasi\n` +
                    `/alerts - Lihat alert aktif\n` +
                    `/uptime - Statistik uptime server\n` +
                    `/help - Tampilkan bantuan\n\n` +
                    `_Server: basic-6.alstore.space:25710_`,
                    { parse_mode: 'Markdown' }
                );
                break;

            case '/status':
                const server = await ServerModel.findOne({ isActive: true });
                if (!server) {
                    await telegramBot.sendMessage(chatId, '❌ Server tidak ditemukan');
                    return;
                }

                const status = server.lastStatus || {};
                const isOnline = status.online || false;
                
                let statusMessage = isOnline ? '🟢 *SERVER ONLINE*\n\n' : '🔴 *SERVER OFFLINE*\n\n';
                statusMessage += `*${server.name}*\n`;
                statusMessage += `📍 ${server.address}:${server.port}\n`;
                statusMessage += `👥 Players: ${status.players?.online || 0}/${status.players?.max || 0}\n`;
                statusMessage += `📶 Ping: ${status.responseTime || 0}ms\n`;
                statusMessage += `📊 Version: ${status.version?.name || 'Unknown'}\n`;
                statusMessage += `🕐 Last Check: ${status.lastCheck ? moment(status.lastCheck).format('DD/MM/YYYY HH:mm:ss') : 'Never'}\n\n`;
                
                if (isOnline) {
                    statusMessage += `✅ Semua sistem berjalan normal`;
                } else {
                    statusMessage += `⚠️ Server sedang mengalami masalah`;
                }

                await telegramBot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
                break;

            case '/subscribe':
                await setSetting(`telegram_subscribed_${chatId}`, true);
                await telegramBot.sendMessage(chatId, 
                    '✅ Anda sekarang berlangganan notifikasi!\n\n' +
                    'Anda akan menerima alert ketika server mengalami masalah.'
                );
                break;

            case '/unsubscribe':
                await setSetting(`telegram_subscribed_${chatId}`, false);
                await telegramBot.sendMessage(chatId, '❌ Anda berhenti berlangganan notifikasi.');
                break;

            case '/alerts':
                const alerts = await Incident.find({ 
                    status: 'active',
                    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
                }).sort({ createdAt: -1 }).limit(5);

                if (alerts.length === 0) {
                    await telegramBot.sendMessage(chatId, '✅ Tidak ada alert aktif dalam 24 jam terakhir.');
                } else {
                    let alertsMessage = '🚨 *Alert Aktif*\n\n';
                    alerts.forEach((alert, index) => {
                        const timeAgo = moment(alert.createdAt).fromNow();
                        alertsMessage += `${index + 1}. *${alert.title}*\n`;
                        alertsMessage += `   ${alert.description}\n`;
                        alertsMessage += `   ⏰ ${timeAgo}\n\n`;
                    });
                    
                    await telegramBot.sendMessage(chatId, alertsMessage.trim(), { parse_mode: 'Markdown' });
                }
                break;

            case '/uptime':
                const servers = await ServerModel.find({ isActive: true });
                let uptimeMessage = '📊 *Statistik Server*\n\n';
                
                for (const srv of servers) {
                    const uptimePercent = srv.stats.totalChecks > 0 
                        ? ((srv.stats.uptimeChecks / srv.stats.totalChecks) * 100).toFixed(2)
                        : 0;
                    
                    uptimeMessage += `*${srv.name}*\n`;
                    uptimeMessage += `📈 Uptime: ${uptimePercent}%\n`;
                    uptimeMessage += `🔍 Checks: ${srv.stats.totalChecks}\n`;
                    uptimeMessage += `⏱️ Downtime: ${(srv.stats.totalDowntime / 60).toFixed(1)} menit\n\n`;
                }
                
                await telegramBot.sendMessage(chatId, uptimeMessage.trim(), { parse_mode: 'Markdown' });
                break;

            case '/help':
                await telegramBot.sendMessage(chatId,
                    '🆘 *Bantuan Bot*\n\n' +
                    '📋 *Perintah yang tersedia:*\n' +
                    '/start - Memulai bot\n' +
                    '/status - Cek status server\n' +
                    '/subscribe - Daftar notifikasi\n' +
                    '/unsubscribe - Berhenti notifikasi\n' +
                    '/alerts - Lihat alert aktif\n' +
                    '/uptime - Statistik uptime\n' +
                    '/help - Bantuan ini\n\n' +
                    '📞 *Support:*\n' +
                    'Untuk bantuan lebih lanjut, hubungi admin.',
                    { parse_mode: 'Markdown' }
                );
                break;
        }
    } catch (error) {
        console.error('Telegram command error:', error);
        await telegramBot.sendMessage(chatId, '❌ Terjadi kesalahan saat memproses perintah.');
    }
}

// Initialize Email
async function initializeEmail() {
    try {
        const emailEnabled = await getSetting('email_enabled', false);
        if (!emailEnabled) {
            console.log('Email notifications disabled');
            return;
        }

        emailTransporter = nodemailer.createTransport({
            host: await getSetting('smtp_host', 'smtp.gmail.com'),
            port: await getSetting('smtp_port', 587),
            secure: false,
            auth: {
                user: await getSetting('smtp_user'),
                pass: await getSetting('smtp_password')
            }
        });

        // Verify connection
        await emailTransporter.verify();
        console.log('✅ Email transporter ready');
        logEvent('info', 'Email', 'Transporter connected successfully');
        
    } catch (error) {
        console.error('Email initialization error:', error);
        logEvent('error', 'Email', 'Initialization failed: ' + error.message);
    }
}

// Send WhatsApp Message
async function sendWhatsAppMessage(phone, message) {
    if (!whatsappReady || !whatsappClient) {
        throw new Error('WhatsApp client not ready');
    }

    try {
        // Format phone number (remove + and add country code if needed)
        let formattedPhone = phone.replace(/\D/g, '');
        if (!formattedPhone.startsWith('62') && formattedPhone.startsWith('0')) {
            formattedPhone = '62' + formattedPhone.substring(1);
        }
        formattedPhone = formattedPhone + '@c.us';

        const sent = await whatsappClient.sendMessage(formattedPhone, message);
        
        await logEvent('info', 'WhatsApp', `Message sent to ${phone}`, {
            messageId: sent.id._serialized,
            phone: phone
        });

        return {
            success: true,
            messageId: sent.id._serialized,
            timestamp: new Date()
        };
    } catch (error) {
        await logEvent('error', 'WhatsApp', `Failed to send to ${phone}: ${error.message}`);
        throw error;
    }
}

// Send Telegram Message
async function sendTelegramMessage(chatId, message, options = {}) {
    if (!telegramReady || !telegramBot) {
        throw new Error('Telegram bot not ready');
    }

    try {
        const sent = await telegramBot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...options
        });

        await logEvent('info', 'Telegram', `Message sent to ${chatId}`, {
            messageId: sent.message_id,
            chatId: chatId
        });

        return {
            success: true,
            messageId: sent.message_id,
            timestamp: new Date()
        };
    } catch (error) {
        await logEvent('error', 'Telegram', `Failed to send to ${chatId}: ${error.message}`);
        throw error;
    }
}

// Send Email
async function sendEmail(to, subject, htmlContent) {
    if (!emailTransporter) {
        throw new Error('Email transporter not ready');
    }

    try {
        const from = await getSetting('smtp_from', await getSetting('smtp_user'));
        
        const mailOptions = {
            from: `"Forexter Monitor" <${from}>`,
            to: to,
            subject: subject,
            html: htmlContent
        };

        const info = await emailTransporter.sendMail(mailOptions);
        
        await logEvent('info', 'Email', `Email sent to ${to}`, {
            messageId: info.messageId,
            to: to,
            subject: subject
        });

        return {
            success: true,
            messageId: info.messageId,
            timestamp: new Date()
        };
    } catch (error) {
        await logEvent('error', 'Email', `Failed to send email to ${to}: ${error.message}`);
        throw error;
    }
}

// Server Monitoring System
class ServerMonitor {
    constructor() {
        this.monitoring = new Map();
        this.incidentCheckers = new Map();
    }

    async init() {
        await this.loadServers();
        logEvent('info', 'Monitor', 'Monitoring system initialized');
    }

    async loadServers() {
        try {
            const servers = await ServerModel.find({ isActive: true });
            console.log(`📊 Loading ${servers.length} servers for monitoring`);
            
            for (const server of servers) {
                await this.startMonitoring(server);
            }
        } catch (error) {
            console.error('Failed to load servers:', error);
            logEvent('error', 'Monitor', 'Failed to load servers: ' + error.message);
        }
    }

    async startMonitoring(server) {
        if (this.monitoring.has(server._id.toString())) {
            clearInterval(this.monitoring.get(server._id.toString()));
        }

        const interval = setInterval(async () => {
            await this.checkServer(server);
        }, server.checkInterval * 1000);

        this.monitoring.set(server._id.toString(), interval);
        
        // Do initial check
        await this.checkServer(server);
        
        logEvent('info', 'Monitor', `Started monitoring ${server.name}`, {
            serverId: server._id,
            interval: server.checkInterval
        });
    }

    async checkServer(server) {
        const startTime = Date.now();
        let responseTime = 0;
        
        try {
            // Update server stats
            server.stats.totalChecks += 1;
            
            // Try to get server status from mcstatus.io
            const apiUrl = `https://api.mcstatus.io/v2/status/${server.type}/${server.address}:${server.port}`;
            const response = await axios.get(apiUrl, { timeout: 10000 });
            
            responseTime = Date.now() - startTime;
            const data = response.data;
            
            const status = {
                online: data.online || false,
                players: data.players || { online: 0, max: 0, list: [] },
                version: data.version || { name: 'Unknown', protocol: -1 },
                motd: data.motd || { clean: 'No MOTD' },
                icon: data.icon || null,
                responseTime: responseTime,
                lastCheck: new Date(),
                rawData: data
            };

            // Update server record
            server.lastStatus = status;
            
            if (status.online) {
                server.stats.uptimeChecks += 1;
            } else {
                server.stats.totalDowntime += server.checkInterval;
            }
            
            await server.save();

            // Emit to WebSocket
            io.emit('server-update', {
                serverId: server._id,
                status: status,
                timestamp: new Date()
            });

            // Check for issues
            await this.checkForIssues(server, status);

            // Log successful check
            await logEvent('debug', 'Monitor', `Checked ${server.name}: ${status.online ? 'Online' : 'Offline'}`, {
                serverId: server._id,
                online: status.online,
                players: status.players.online,
                responseTime: responseTime
            });

        } catch (error) {
            responseTime = Date.now() - startTime;
            
            // Server is considered offline on error
            const status = {
                online: false,
                error: error.message,
                responseTime: responseTime,
                lastCheck: new Date()
            };

            server.lastStatus = status;
            server.stats.totalDowntime += server.checkInterval;
            await server.save();

            // Emit update
            io.emit('server-update', {
                serverId: server._id,
                status: status,
                timestamp: new Date()
            });

            // Check if this is a new offline incident
            await this.checkForIssues(server, status);

            await logEvent('error', 'Monitor', `Failed to check ${server.name}: ${error.message}`, {
                serverId: server._id,
                error: error.message,
                responseTime: responseTime
            });
        }
    }

    async checkForIssues(server, status) {
        const issues = [];
        
        // Check if server is offline
        if (!status.online) {
            issues.push({
                type: 'server_offline',
                severity: 'critical',
                title: 'Server Offline',
                description: `Server ${server.name} is not responding. Error: ${status.error || 'Connection timeout'}`
            });
        }
        
        // Check latency
        if (status.responseTime > 1000) {
            issues.push({
                type: 'high_latency',
                severity: 'warning',
                title: 'High Latency',
                description: `Server ${server.name} has high latency: ${status.responseTime}ms`
            });
        }
        
        // Check player capacity
        if (status.players && status.players.online === status.players.max && status.players.max > 0) {
            issues.push({
                type: 'full_capacity',
                severity: 'warning',
                title: 'Server Full',
                description: `Server ${server.name} is at full capacity (${status.players.online}/${status.players.max})`
            });
        }
        
        // Check version mismatch (for Bedrock)
        if (status.version && status.version.protocol && status.version.protocol < 671) {
            issues.push({
                type: 'version_mismatch',
                severity: 'info',
                title: 'Old Version',
                description: `Server ${server.name} is running an old version: ${status.version.name}`
            });
        }

        // Process each issue
        for (const issue of issues) {
            await this.handleIssue(server, issue);
        }
    }

    async handleIssue(server, issue) {
        try {
            // Check if similar active incident exists
            const existingIncident = await Incident.findOne({
                serverId: server._id,
                type: issue.type,
                status: 'active',
                createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Last 30 minutes
            });

            if (existingIncident) {
                // Update existing incident
                existingIncident.updatedAt = new Date();
                await existingIncident.save();
                return;
            }

            // Create new incident
            const incident = new Incident({
                serverId: server._id,
                type: issue.type,
                title: issue.title,
                description: issue.description,
                severity: issue.severity,
                status: 'active',
                data: {
                    serverName: server.name,
                    serverAddress: `${server.address}:${server.port}`,
                    timestamp: new Date()
                }
            });

            await incident.save();

            // Send notifications
            await this.sendIncidentNotifications(incident, server);

            // Emit to WebSocket
            io.emit('incident', {
                incident: incident,
                server: server
            });

            // Log incident
            await logEvent(issue.severity, 'Monitor', `New incident: ${issue.title}`, {
                incidentId: incident._id,
                serverId: server._id,
                type: issue.type,
                severity: issue.severity
            });

            // Set up auto-resolve check for server recovery
            if (issue.type === 'server_offline') {
                this.setupRecoveryCheck(server, incident);
            }

        } catch (error) {
            await logEvent('error', 'Monitor', `Failed to handle issue: ${error.message}`, {
                serverId: server._id,
                issue: issue
            });
        }
    }

    async sendIncidentNotifications(incident, server) {
        try {
            const notifications = [];
            const incidentMessage = `🚨 ${incident.severity.toUpperCase()}: ${server.name}\n\n${incident.description}\n\nTime: ${moment().format('DD/MM/YYYY HH:mm:ss')}`;
            
            // Get notification settings
            const emailEnabled = await getSetting('email_enabled', false);
            const telegramEnabled = await getSetting('telegram_enabled', true);
            const whatsappEnabled = await getSetting('whatsapp_enabled', false);
            
            const adminEmail = await getSetting('admin_email');
            const adminPhone = await getSetting('admin_phone');
            
            // Check severity settings
            const sendCritical = await getSetting('notify_critical', true);
            const sendWarning = await getSetting('notify_warning', true);
            const sendInfo = await getSetting('notify_info', false);
            
            let shouldSend = false;
            switch (incident.severity) {
                case 'critical': shouldSend = sendCritical; break;
                case 'warning': shouldSend = sendWarning; break;
                case 'info': shouldSend = sendInfo; break;
            }
            
            if (!shouldSend) return;

            // Send Email
            if (emailEnabled && adminEmail) {
                try {
                    const emailHtml = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <div style="background: ${incident.severity === 'critical' ? '#dc3545' : incident.severity === 'warning' ? '#ffc107' : '#17a2b8'}; color: white; padding: 20px; border-radius: 5px 5px 0 0;">
                                <h2 style="margin: 0;">${incident.title}</h2>
                            </div>
                            <div style="padding: 20px; background: #f8f9fa; border: 1px solid #dee2e6; border-top: none;">
                                <h3>Server: ${server.name}</h3>
                                <p>${incident.description}</p>
                                <hr>
                                <p><strong>Server Address:</strong> ${server.address}:${server.port}</p>
                                <p><strong>Time:</strong> ${moment().format('DD/MM/YYYY HH:mm:ss')}</p>
                                <p><strong>Severity:</strong> ${incident.severity}</p>
                                <hr>
                                <p style="color: #6c757d; font-size: 12px;">
                                    This is an automated notification from Forexter Network Monitoring System.
                                </p>
                            </div>
                        </div>
                    `;
                    
                    await sendEmail(adminEmail, `[${incident.severity.toUpperCase()}] ${incident.title}`, emailHtml);
                    
                    notifications.push({
                        type: 'email',
                        recipient: adminEmail,
                        status: 'sent'
                    });
                    
                } catch (error) {
                    notifications.push({
                        type: 'email',
                        recipient: adminEmail,
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            // Send WhatsApp
            if (whatsappEnabled && adminPhone && whatsappReady) {
                try {
                    await sendWhatsAppMessage(adminPhone, incidentMessage);
                    
                    notifications.push({
                        type: 'whatsapp',
                        recipient: adminPhone,
                        status: 'sent'
                    });
                    
                } catch (error) {
                    notifications.push({
                        type: 'whatsapp',
                        recipient: adminPhone,
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            // Send Telegram
            if (telegramEnabled && telegramReady) {
                try {
                    // Get all subscribed chat IDs
                    const settings = await Setting.find({ key: /^telegram_subscribed_/ });
                    const subscribedChats = settings.filter(s => s.value === true);
                    
                    for (const setting of subscribedChats) {
                        const chatId = setting.key.replace('telegram_subscribed_', '');
                        try {
                            await sendTelegramMessage(chatId, incidentMessage);
                            
                            notifications.push({
                                type: 'telegram',
                                recipient: chatId,
                                status: 'sent'
                            });
                            
                        } catch (error) {
                            notifications.push({
                                type: 'telegram',
                                recipient: chatId,
                                status: 'failed',
                                error: error.message
                            });
                        }
                    }
                    
                } catch (error) {
                    notifications.push({
                        type: 'telegram',
                        recipient: 'subscribers',
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            // Save notification records
            for (const notif of notifications) {
                const notification = new Notification({
                    type: notif.type,
                    title: incident.title,
                    message: incident.description,
                    recipient: notif.recipient,
                    status: notif.status,
                    error: notif.error,
                    sentAt: new Date()
                });
                await notification.save();
            }

            // Mark incident as notified
            incident.notificationsSent = true;
            await incident.save();

        } catch (error) {
            await logEvent('error', 'Monitor', `Failed to send notifications: ${error.message}`, {
                incidentId: incident._id
            });
        }
    }

    setupRecoveryCheck(server, incident) {
        const checkInterval = setInterval(async () => {
            try {
                const currentServer = await ServerModel.findById(server._id);
                if (currentServer.lastStatus && currentServer.lastStatus.online) {
                    // Server is back online!
                    clearInterval(checkInterval);
                    this.incidentCheckers.delete(incident._id.toString());
                    
                    // Resolve the incident
                    incident.status = 'resolved';
                    incident.resolvedAt = new Date();
                    await incident.save();
                    
                    // Send recovery notification
                    await this.sendRecoveryNotification(server, incident);
                    
                    // Emit update
                    io.emit('incident-resolved', {
                        incidentId: incident._id,
                        serverId: server._id,
                        timestamp: new Date()
                    });
                    
                    await logEvent('info', 'Monitor', `Server ${server.name} recovered`, {
                        serverId: server._id,
                        incidentId: incident._id
                    });
                }
            } catch (error) {
                console.error('Recovery check error:', error);
            }
        }, 60000); // Check every minute

        this.incidentCheckers.set(incident._id.toString(), checkInterval);
    }

    async sendRecoveryNotification(server, incident) {
        try {
            const recoveryMessage = `✅ Server Recovery: ${server.name}\n\nServer is back online after being down for ${moment(incident.createdAt).fromNow(true)}.\n\nTime: ${moment().format('DD/MM/YYYY HH:mm:ss')}`;
            
            // Similar to incident notifications but with success message
            const emailEnabled = await getSetting('email_enabled', false);
            const telegramEnabled = await getSetting('telegram_enabled', true);
            const whatsappEnabled = await getSetting('whatsapp_enabled', false);
            
            const adminEmail = await getSetting('admin_email');
            const adminPhone = await getSetting('admin_phone');
            
            if (emailEnabled && adminEmail) {
                await sendEmail(adminEmail, `[RECOVERY] ${server.name} Back Online`, 
                    `<h2>✅ Server Recovery</h2>
                    <p><strong>Server:</strong> ${server.name}</p>
                    <p><strong>Status:</strong> Back Online</p>
                    <p><strong>Downtime:</strong> ${moment(incident.createdAt).fromNow(true)}</p>
                    <p><strong>Time:</strong> ${moment().format('DD/MM/YYYY HH:mm:ss')}</p>`);
            }
            
            if (whatsappEnabled && adminPhone && whatsappReady) {
                await sendWhatsAppMessage(adminPhone, recoveryMessage);
            }
            
            if (telegramEnabled && telegramReady) {
                const settings = await Setting.find({ key: /^telegram_subscribed_/ });
                const subscribedChats = settings.filter(s => s.value === true);
                
                for (const setting of subscribedChats) {
                    const chatId = setting.key.replace('telegram_subscribed_', '');
                    await sendTelegramMessage(chatId, recoveryMessage);
                }
            }
            
        } catch (error) {
            await logEvent('error', 'Monitor', `Failed to send recovery notification: ${error.message}`);
        }
    }

    stopMonitoring(serverId) {
        if (this.monitoring.has(serverId)) {
            clearInterval(this.monitoring.get(serverId));
            this.monitoring.delete(serverId);
        }
    }
}

// Initialize Monitor
const monitor = new ServerMonitor();

// API Routes

// Authentication Middleware
const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'forexter-secret');
        const user = await User.findById(decoded.userId);
        
        if (!user || !user.isActive) {
            return res.status(401).json({ error: 'User not found or inactive' });
        }

        req.user = user;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const authenticateAdmin = async (req, res, next) => {
    await authenticate(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
};

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        // Check if user exists
        const existingUser = await User.findOne({ 
            $or: [{ username }, { email }] 
        });
        
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user
        const user = new User({
            username,
            email,
            password: hashedPassword,
            role: 'admin'
        });

        await user.save();
        
        // Create token
        const token = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.JWT_SECRET || 'forexter-secret',
            { expiresIn: '7d' }
        );

        await logEvent('info', 'Auth', `New user registered: ${username}`, {
            userId: user._id,
            email: email
        });

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
        await logEvent('error', 'Auth', 'Registration failed: ' + error.message);
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Find user
        const user = await User.findOne({
            $or: [{ username }, { email: username }],
            isActive: true
        });
        
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login
        user.lastLogin = new Date();
        await user.save();

        // Create token
        const token = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.JWT_SECRET || 'forexter-secret',
            { expiresIn: '7d' }
        );

        await logEvent('info', 'Auth', `User logged in: ${username}`, {
            userId: user._id
        });

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
        await logEvent('error', 'Auth', 'Login failed: ' + error.message);
    }
});

// Server Routes
app.get('/api/servers', authenticate, async (req, res) => {
    try {
        const servers = await ServerModel.find().sort({ createdAt: -1 });
        res.json(servers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/servers/:id', authenticate, async (req, res) => {
    try {
        const server = await ServerModel.findById(req.params.id);
        if (!server) {
            return res.status(404).json({ error: 'Server not found' });
        }
        res.json(server);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/servers', authenticateAdmin, async (req, res) => {
    try {
        const server = new ServerModel(req.body);
        await server.save();
        
        // Start monitoring
        monitor.startMonitoring(server);
        
        await logEvent('info', 'Server', `Server added: ${server.name}`, {
            serverId: server._id,
            address: `${server.address}:${server.port}`
        });

        res.json(server);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/servers/:id', authenticateAdmin, async (req, res) => {
    try {
        const server = await ServerModel.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        
        if (server.isActive) {
            monitor.startMonitoring(server);
        } else {
            monitor.stopMonitoring(server._id);
        }
        
        await logEvent('info', 'Server', `Server updated: ${server.name}`);
        res.json(server);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/servers/:id', authenticateAdmin, async (req, res) => {
    try {
        const server = await ServerModel.findById(req.params.id);
        if (!server) {
            return res.status(404).json({ error: 'Server not found' });
        }
        
        monitor.stopMonitoring(server._id);
        await server.deleteOne();
        
        await logEvent('info', 'Server', `Server deleted: ${server.name}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/servers/:id/check', authenticate, async (req, res) => {
    try {
        const server = await ServerModel.findById(req.params.id);
        if (!server) {
            return res.status(404).json({ error: 'Server not found' });
        }
        
        await monitor.checkServer(server);
        res.json({ 
            success: true, 
            message: 'Server check completed',
            status: server.lastStatus 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Status Endpoint (Public)
app.get('/api/status', async (req, res) => {
    try {
        const server = await ServerModel.findOne({ isActive: true });
        if (!server) {
            return res.status(404).json({ error: 'No active server found' });
        }

        const status = server.lastStatus || {};
        
        // Enhanced status with diagnostics
        const enhancedStatus = {
            online: status.online || false,
            players: status.players || { online: 0, max: 0, list: [] },
            version: status.version || { name: 'Unknown', protocol: -1 },
            motd: status.motd || { clean: 'Server Offline' },
            icon: status.icon,
            responseTime: status.responseTime || 0,
            lastCheck: status.lastCheck || new Date(),
            serverInfo: {
                name: server.name,
                address: `${server.address}:${server.port}`,
                type: server.type
            },
            stats: {
                uptime: server.stats.totalChecks > 0 
                    ? ((server.stats.uptimeChecks / server.stats.totalChecks) * 100).toFixed(2)
                    : 0,
                totalChecks: server.stats.totalChecks,
                totalDowntime: server.stats.totalDowntime
            },
            diagnostics: await getServerDiagnostics(server, status)
        };

        res.json(enhancedStatus);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function getServerDiagnostics(server, status) {
    const diagnostics = {
        network: status.online ? 'healthy' : 'unhealthy',
        latency: status.responseTime || 0,
        latencyStatus: status.responseTime < 100 ? 'excellent' : 
                      status.responseTime < 300 ? 'good' : 
                      status.responseTime < 500 ? 'fair' : 'poor',
        playersConnected: status.players?.online || 0,
        serverLoad: status.players?.online > (status.players?.max * 0.8) ? 'high' : 'normal',
        versionCompatibility: status.version?.protocol === 671 ? 'compatible' : 'check_version'
    };
    
    return diagnostics;
}

// Incident Routes
app.get('/api/incidents', authenticate, async (req, res) => {
    try {
        const { limit = 50, status, severity, serverId } = req.query;
        const query = {};
        
        if (status) query.status = status;
        if (severity) query.severity = severity;
        if (serverId) query.serverId = serverId;
        
        const incidents = await Incident.find(query)
            .populate('serverId', 'name address port')
            .sort({ createdAt: -1 })
            .limit(parseInt(limit));
        
        res.json(incidents);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/incidents/:id/resolve', authenticateAdmin, async (req, res) => {
    try {
        const incident = await Incident.findById(req.params.id);
        if (!incident) {
            return res.status(404).json({ error: 'Incident not found' });
        }
        
        incident.status = 'resolved';
        incident.resolvedAt = new Date();
        await incident.save();
        
        await logEvent('info', 'Incident', `Incident resolved: ${incident.title}`, {
            incidentId: incident._id
        });
        
        res.json(incident);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Notification Routes
app.get('/api/notifications', authenticate, async (req, res) => {
    try {
        const { limit = 100, type, status } = req.query;
        const query = {};
        
        if (type) query.type = type;
        if (status) query.status = status;
        
        const notifications = await Notification.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit));
        
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Settings Routes
app.get('/api/settings', authenticate, async (req, res) => {
    try {
        const settings = await Setting.find();
        const settingsObj = {};
        settings.forEach(s => settingsObj[s.key] = s.value);
        res.json(settingsObj);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/settings', authenticateAdmin, async (req, res) => {
    try {
        const updates = req.body;
        const results = [];
        
        for (const [key, value] of Object.entries(updates)) {
            await setSetting(key, value);
            results.push({ key, value });
        }
        
        await logEvent('info', 'Settings', 'Settings updated', { updates });
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Logs Routes
app.get('/api/logs', authenticateAdmin, async (req, res) => {
    try {
        const { limit = 100, level, source, startDate, endDate } = req.query;
        const query = {};
        
        if (level) query.level = level;
        if (source) query.source = source;
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate);
            if (endDate) query.createdAt.$lte = new Date(endDate);
        }
        
        const logs = await Log.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit));
        
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stats Routes
app.get('/api/stats', authenticate, async (req, res) => {
    try {
        const [servers, incidents, notifications, users] = await Promise.all([
            ServerModel.countDocuments(),
            Incident.countDocuments(),
            Notification.countDocuments(),
            User.countDocuments()
        ]);
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const todayIncidents = await Incident.countDocuments({ 
            createdAt: { $gte: today } 
        });
        
        const activeIncidents = await Incident.countDocuments({ 
            status: 'active' 
        });
        
        res.json({
            servers,
            incidents: {
                total: incidents,
                today: todayIncidents,
                active: activeIncidents
            },
            notifications: {
                total: notifications
            },
            users
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test Notification Routes
app.post('/api/test/notification', authenticateAdmin, async (req, res) => {
    try {
        const { type, recipient, message } = req.body;
        
        let result;
        const testMessage = message || 'This is a test notification from Forexter Network Monitoring System';
        
        switch (type) {
            case 'email':
                if (!recipient) {
                    return res.status(400).json({ error: 'Recipient email required' });
                }
                result = await sendEmail(recipient, 'Test Notification', 
                    `<h2>Test Notification</h2><p>${testMessage}</p>`);
                break;
                
            case 'whatsapp':
                if (!recipient) {
                    return res.status(400).json({ error: 'Recipient phone required' });
                }
                if (!whatsappReady) {
                    return res.status(400).json({ error: 'WhatsApp client not ready' });
                }
                result = await sendWhatsAppMessage(recipient, `Test Notification\n\n${testMessage}`);
                break;
                
            case 'telegram':
                if (!recipient) {
                    // Send to all subscribed users
                    const settings = await Setting.find({ key: /^telegram_subscribed_/ });
                    const subscribedChats = settings.filter(s => s.value === true);
                    
                    for (const setting of subscribedChats) {
                        const chatId = setting.key.replace('telegram_subscribed_', '');
                        await sendTelegramMessage(chatId, `Test Notification\n\n${testMessage}`);
                    }
                    result = { success: true, sentTo: subscribedChats.length };
                } else {
                    result = await sendTelegramMessage(recipient, `Test Notification\n\n${testMessage}`);
                }
                break;
                
            default:
                return res.status(400).json({ error: 'Invalid notification type' });
        }
        
        await logEvent('info', 'Test', `Test ${type} notification sent`, {
            type: type,
            recipient: recipient,
            result: result
        });
        
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
        await logEvent('error', 'Test', `Test notification failed: ${error.message}`);
    }
});

// WhatsApp Routes
app.get('/api/whatsapp/status', authenticate, async (req, res) => {
    try {
        res.json({
            ready: whatsappReady,
            connected: whatsappClient ? true : false
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/whatsapp/restart', authenticateAdmin, async (req, res) => {
    try {
        if (whatsappClient) {
            await whatsappClient.destroy();
        }
        
        setTimeout(() => {
            initializeWhatsApp();
        }, 2000);
        
        res.json({ success: true, message: 'WhatsApp client restarting' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Telegram Routes
app.get('/api/telegram/status', authenticate, async (req, res) => {
    try {
        res.json({
            ready: telegramReady,
            connected: telegramBot ? true : false
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/telegram/subscribers', authenticate, async (req, res) => {
    try {
        const settings = await Setting.find({ key: /^telegram_subscribed_/ });
        const subscribers = settings.filter(s => s.value === true);
        
        const result = await Promise.all(subscribers.map(async (setting) => {
            const chatId = setting.key.replace('telegram_subscribed_', '');
            const userInfo = await getSetting(`telegram_chat_${chatId}`, {});
            return {
                chatId,
                subscribed: true,
                userInfo
            };
        }));
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Backup Routes
app.post('/api/backup', authenticateAdmin, async (req, res) => {
    try {
        const timestamp = moment().format('YYYYMMDD_HHmmss');
        const backupName = `backup_${timestamp}`;
        
        // Collect all data
        const backupData = {
            timestamp: new Date(),
            servers: await ServerModel.find(),
            incidents: await Incident.find().limit(1000),
            notifications: await Notification.find().limit(1000),
            settings: await Setting.find(),
            users: await User.find().select('-password'),
            logs: await Log.find().sort({ createdAt: -1 }).limit(1000)
        };
        
        // Create backup record
        const backup = new Backup({
            name: backupName,
            filename: `${backupName}.json`,
            size: JSON.stringify(backupData).length,
            type: 'full',
            data: backupData
        });
        
        await backup.save();
        
        // Save to file
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        const backupPath = path.join(backupDir, `${backupName}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
        
        await logEvent('info', 'Backup', `Backup created: ${backupName}`, {
            backupId: backup._id,
            size: backup.size
        });
        
        res.json({ 
            success: true, 
            message: 'Backup created', 
            backup: {
                id: backup._id,
                name: backup.name,
                size: backup.size,
                timestamp: backup.createdAt
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
        await logEvent('error', 'Backup', `Backup failed: ${error.message}`);
    }
});

app.get('/api/backups', authenticateAdmin, async (req, res) => {
    try {
        const backups = await Backup.find().sort({ createdAt: -1 });
        res.json(backups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// WebSocket Connection
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    socket.on('join', (room) => {
        socket.join(room);
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Initialize System
async function initializeSystem() {
    try {
        console.log('\n🚀 Initializing Forexter Network Monitoring System...\n');
        
        // Initialize services
        await initializeEmail();
        await initializeTelegram();
        await initializeWhatsApp();
        
        // Initialize monitor
        await monitor.init();
        
        // Check for default data
        await checkDefaultData();
        
        console.log('\n✅ System initialization complete!');
        console.log('🌐 Server running on port', process.env.PORT || 3000);
        console.log('📱 Telegram Bot:', telegramReady ? '✅ Ready' : '❌ Not ready');
        console.log('💬 WhatsApp:', whatsappReady ? '✅ Ready' : '❌ Not ready');
        console.log('📧 Email:', emailTransporter ? '✅ Ready' : '❌ Not ready');
        console.log('\n🔗 Status Page: http://localhost:' + (process.env.PORT || 3000));
        console.log('👑 Admin Panel: http://localhost:' + (process.env.PORT || 3000) + '/admin');
        
    } catch (error) {
        console.error('System initialization failed:', error);
        process.exit(1);
    }
}

async function checkDefaultData() {
    try {
        // Check for admin user
        const adminExists = await User.findOne({ username: 'admin' });
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            const admin = new User({
                username: 'admin',
                email: 'admin@forexter.network',
                password: hashedPassword,
                role: 'admin'
            });
            await admin.save();
            console.log('✅ Default admin user created (admin/admin123)');
        }
        
        // Check for default server
        const serverExists = await ServerModel.findOne();
        if (!serverExists) {
            const server = new ServerModel({
                name: 'Forexter Network',
                address: 'basic-6.alstore.space',
                port: 25710,
                type: 'bedrock',
                isActive: true
            });
            await server.save();
            console.log('✅ Default server created');
        }
        
        // Set default settings
        const defaultSettings = {
            'email_enabled': false,
            'telegram_enabled': true,
            'whatsapp_enabled': false,
            'notify_critical': true,
            'notify_warning': true,
            'notify_info': false,
            'check_interval': 10,
            'admin_email': 'admin@forexter.network',
            'admin_phone': '',
            'smtp_host': 'smtp.gmail.com',
            'smtp_port': 587,
            'smtp_user': '',
            'smtp_password': '',
            'smtp_from': 'Forexter Monitor'
        };
        
        for (const [key, value] of Object.entries(defaultSettings)) {
            const exists = await Setting.findOne({ key });
            if (!exists) {
                await setSetting(key, value, `Default setting for ${key}`);
            }
        }
        
        console.log('✅ Default settings configured');
        
    } catch (error) {
        console.error('Failed to setup default data:', error);
    }
}

// Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🌐 Server started on port ${PORT}`);
    initializeSystem();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    
    // Stop monitoring
    for (const [serverId, interval] of monitor.monitoring) {
        clearInterval(interval);
    }
    
    // Stop WhatsApp client
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    
    // Stop Telegram bot
    if (telegramBot) {
        telegramBot.stopPolling();
    }
    
    // Close database connection
    await mongoose.connection.close();
    
    console.log('Cleanup completed, exiting...');
    process.exit(0);
});
