#!/usr/bin/env node

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log(`
╔══════════════════════════════════════════════╗
║          WHATSAPP CLIENT SETUP               ║
╚══════════════════════════════════════════════╝
`);

async function setupWhatsApp() {
    console.log('\n📱 SETUP WHATSAPP NOTIFIKASI:\n');
    console.log('1. Pastikan WhatsApp terinstal di HP');
    console.log('2. Scan QR Code yang akan muncul');
    console.log('3. Tunggu sampai terkoneksi\n');
    
    console.log('⚠️  PERINGATAN:');
    console.log('• Jangan logout WhatsApp di HP selama monitoring');
    console.log('• HP harus tetap terhubung ke internet');
    console.log('• Gunakan nomor WhatsApp yang jarang dipakai\n');
    
    rl.question('TEKAN ENTER UNTUK MEMULAI...', () => {
        startWhatsAppClient();
    });
}

function startWhatsAppClient() {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: "forexter-whatsapp-setup"
        }),
        puppeteer: {
            headless: false, // Show browser for setup
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('\n📱 SCAN QR CODE INI DENGAN WHATSAPP:');
        console.log('1. Buka WhatsApp di HP');
        console.log('2. Tap menu titik tiga (⋮)');
        console.log('3. Pilih "Linked Devices"');
        console.log('4. Tap "Link a Device"');
        console.log('5. Scan QR Code di bawah:\n');
        
        qrcode.generate(qr, { small: true });
        console.log('\n');
        
        // Save QR to file
        const qrDir = path.join(__dirname, 'whatsapp-qr');
        if (!fs.existsSync(qrDir)) {
            fs.mkdirSync(qrDir, { recursive: true });
        }
        
        const qrPath = path.join(qrDir, 'qr-code.txt');
        fs.writeFileSync(qrPath, qr);
        console.log(`QR Code juga disimpan di: ${qrPath}`);
    });

    client.on('ready', async () => {
        console.log('\n✅ WHATSAPP TERKONEKSI!');
        
        // Get client info
        const clientInfo = client.info;
        console.log(`\n📱 Nomor WhatsApp: ${clientInfo.wid.user}`);
        console.log(`👤 Nama: ${clientInfo.pushname}`);
        
        // Save configuration
        await saveWhatsAppConfig(clientInfo);
        
        console.log('\n🎉 Setup WhatsApp selesai!');
        console.log('\n⚠️  JANGAN TUTUP WINDOW INI!');
        console.log('   Biarkan terbuka untuk menerima notifikasi');
        
        // Keep the connection alive
        setTimeout(() => {
            console.log('\n🔗 WhatsApp siap menerima notifikasi...');
            console.log('   Untuk menghentikan, tekan Ctrl+C');
        }, 2000);
    });

    client.on('authenticated', () => {
        console.log('🔐 WhatsApp terautentikasi!');
    });

    client.on('auth_failure', (msg) => {
        console.log('❌ Autentikasi gagal:', msg);
        rl.question('Coba lagi? (y/n): ', (answer) => {
            if (answer.toLowerCase() === 'y') {
                startWhatsAppClient();
            } else {
                process.exit(0);
            }
        });
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp terputus:', reason);
        console.log('   Jalankan lagi: npm run setup-whatsapp');
        process.exit(0);
    });

    client.initialize();
}

async function saveWhatsAppConfig(clientInfo) {
    const envPath = path.join(__dirname, '.env');
    
    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
        
        // Remove existing WhatsApp config
        envContent = envContent.replace(/WHATSAPP_ENABLED=.*\n/g, '');
        envContent = envContent.replace(/ADMIN_PHONE=.*\n/g, '');
    }
    
    envContent += `\n# WhatsApp Configuration\n`;
    envContent += `WHATSAPP_ENABLED=true\n`;
    envContent += `ADMIN_PHONE=${clientInfo.wid.user}\n`;
    
    fs.writeFileSync(envPath, envContent);
    
    // Save detailed info
    const whatsappInfo = {
        phoneNumber: clientInfo.wid.user,
        pushname: clientInfo.pushname,
        platform: clientInfo.platform,
        connectedAt: new Date(),
        clientId: "forexter-whatsapp"
    };
    
    const infoPath = path.join(__dirname, 'whatsapp-info.json');
    fs.writeFileSync(infoPath, JSON.stringify(whatsappInfo, null, 2));
}

setupWhatsApp();
