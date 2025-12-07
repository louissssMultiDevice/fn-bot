#!/usr/bin/env node

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log(`
╔══════════════════════════════════════════════╗
║          EMAIL NOTIFICATION SETUP            ║
╚══════════════════════════════════════════════╝
`);

async function setupEmail() {
    console.log('\n📧 SETUP EMAIL NOTIFIKASI (GMAIL):\n');
    
    console.log('📋 PERSIAPAN:');
    console.log('1. Pastikan punya akun Gmail');
    console.log('2. Aktifkan 2-Step Verification:');
    console.log('   https://myaccount.google.com/security');
    console.log('3. Buat App Password:');
    console.log('   https://myaccount.google.com/apppasswords\n');
    
    rl.question('MASUKKAN EMAIL GMAIL ANDA: ', async (email) => {
        rl.question('MASUKKAN APP PASSWORD (16 karakter): ', async (password) => {
            console.log('\n🔍 Menguji koneksi email...');
            
            try {
                const transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: {
                        user: email,
                        pass: password
                    }
                });
                
                // Verify connection
                await transporter.verify();
                console.log('✅ Koneksi email berhasil!');
                
                // Send test email
                const info = await transporter.sendMail({
                    from: `"Forexter Monitor" <${email}>`,
                    to: email,
                    subject: 'Test Email from Forexter Monitor',
                    html: '<h2>Test Email Notification</h2><p>Email notifikasi berhasil dikonfigurasi!</p>'
                });
                
                console.log('✅ Test email terkirim!');
                
                // Save configuration
                saveEmailConfig(email, password);
                
                console.log('\n🎉 Setup email selesai!');
                console.log('📧 Notifikasi akan dikirim ke:', email);
                
                rl.close();
                
            } catch (error) {
                console.log('\n❌ Gagal mengkonfigurasi email:');
                console.log('   Error:', error.message);
                console.log('\n🔧 TROUBLESHOOTING:');
                console.log('1. Pastikan 2-Step Verification aktif');
                console.log('2. Pastikan App Password benar (16 karakter)');
                console.log('3. Coba aktifkan "Less secure app access"');
                console.log('4. Pastikan tidak ada spasi di password');
                
                rl.question('\nCoba lagi? (y/n): ', (answer) => {
                    if (answer.toLowerCase() === 'y') {
                        setupEmail();
                    } else {
                        rl.close();
                    }
                });
            }
        });
    });
}

function saveEmailConfig(email, password) {
    const envPath = path.join(__dirname, '.env');
    
    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
        
        // Remove existing email config
        envContent = envContent.replace(/EMAIL_ENABLED=.*\n/g, '');
        envContent = envContent.replace(/SMTP_USER=.*\n/g, '');
        envContent = envContent.replace(/SMTP_PASSWORD=.*\n/g, '');
        envContent = envContent.replace(/ADMIN_EMAIL=.*\n/g, '');
        envContent = envContent.replace(/SMTP_FROM=.*\n/g, '');
    }
    
    envContent += `\n# Email Configuration\n`;
    envContent += `EMAIL_ENABLED=true\n`;
    envContent += `SMTP_USER=${email}\n`;
    envContent += `SMTP_PASSWORD=${password}\n`;
    envContent += `ADMIN_EMAIL=${email}\n`;
    envContent += `SMTP_FROM=Forexter Monitor <${email}>\n`;
    
    fs.writeFileSync(envPath, envContent);
    
    // Save email info
    const emailInfo = {
        email: email,
        configuredAt: new Date(),
        service: 'Gmail'
    };
    
    const infoPath = path.join(__dirname, 'email-info.json');
    fs.writeFileSync(infoPath, JSON.stringify(emailInfo, null, 2));
}

setupEmail();
