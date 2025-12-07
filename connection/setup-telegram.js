#!/usr/bin/env node

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log(`
╔══════════════════════════════════════════════╗
║          TELEGRAM BOT SETUP                  ║
╚══════════════════════════════════════════════╝
`);

async function setupTelegram() {
    console.log('\n📱 CARA MEMBUAT TELEGRAM BOT:\n');
    console.log('1. Buka Telegram di HP/PC');
    console.log('2. Cari @BotFather (Official Telegram Bot)');
    console.log('3. Kirim pesan: /newbot');
    console.log('4. Ikuti instruksi untuk membuat bot baru');
    console.log('5. Beri nama bot: Forexter Monitor');
    console.log('6. Beri username: forexter_monitor_bot');
    console.log('7. Simpan token yang diberikan\n');
    
    rl.question('MASUKKAN TELEGRAM BOT TOKEN: ', async (token) => {
        if (!token || token.length < 30) {
            console.log('\n❌ Token tidak valid!');
            rl.close();
            return;
        }
        
        try {
            // Test the token
            console.log('\n🔍 Mengecek token...');
            const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
            
            if (response.data.ok) {
                const botInfo = response.data.result;
                console.log('\n✅ Token valid!');
                console.log(`   🤖 Bot: ${botInfo.first_name} (@${botInfo.username})`);
                
                rl.question('\nMASUKKAN CHAT ID ANDA (kosongkan jika belum tahu): ', async (chatId) => {
                    if (!chatId) {
                        console.log('\n🔍 Cara mendapatkan Chat ID:');
                        console.log('1. Buka bot yang baru dibuat di Telegram');
                        console.log('2. Kirim pesan apa saja ke bot');
                        console.log('3. Buka URL ini di browser:');
                        console.log(`   https://api.telegram.org/bot${token}/getUpdates`);
                        console.log('4. Cari "chat":{"id":xxxxx}');
                        console.log('5. Copy angka setelah "id":');
                        
                        rl.question('\nMASUKKAN CHAT ID SEKARANG: ', (finalChatId) => {
                            saveConfig(token, finalChatId, botInfo);
                            rl.close();
                        });
                    } else {
                        saveConfig(token, chatId, botInfo);
                        rl.close();
                    }
                });
            } else {
                console.log('\n❌ Token tidak valid!');
                rl.close();
            }
            
        } catch (error) {
            console.log('\n❌ Token tidak valid atau ada masalah koneksi!');
            console.log('   Error:', error.message);
            rl.close();
        }
    });
}

function saveConfig(token, chatId, botInfo) {
    const envPath = path.join(__dirname, '.env');
    
    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
        
        // Remove existing Telegram config
        envContent = envContent.replace(/TELEGRAM_BOT_TOKEN=.*\n/g, '');
        envContent = envContent.replace(/TELEGRAM_CHAT_ID=.*\n/g, '');
    } else {
        envContent = '# Forexter Network Configuration\n\n';
    }
    
    envContent += `\n# Telegram Bot Configuration\n`;
    envContent += `TELEGRAM_BOT_TOKEN=${token}\n`;
    envContent += `TELEGRAM_CHAT_ID=${chatId}\n`;
    
    fs.writeFileSync(envPath, envContent);
    
    console.log('\n✅ KONFIGURASI BERHASIL DISIMPAN!');
    console.log('\n🎉 Bot Telegram siap digunakan!');
    console.log('\n📋 LANGKAH SELANJUTNYA:');
    console.log('1. Buka bot di Telegram: @' + botInfo.username);
    console.log('2. Kirim pesan: /start');
    console.log('3. Jalankan server: npm start');
    console.log('4. Bot akan mengirim notifikasi otomatis');
    console.log('\n⚡ FITUR BOT:');
    console.log('• /status - Cek status server');
    console.log('• /subscribe - Dapatkan notifikasi');
    console.log('• /alerts - Lihat alert aktif');
    console.log('• /uptime - Statistik server');
    console.log('• /help - Tampilkan bantuan');
    console.log('\n🔗 Bot URL: https://t.me/' + botInfo.username);
    
    // Save bot info to file
    const botInfoPath = path.join(__dirname, 'telegram-bot-info.json');
    fs.writeFileSync(botInfoPath, JSON.stringify({
        token: token,
        chatId: chatId,
        botInfo: botInfo,
        setupDate: new Date()
    }, null, 2));
}

setupTelegram();
