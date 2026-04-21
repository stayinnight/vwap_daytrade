import fs from 'fs'
import { resolve, parse } from 'path'
import dayjs from 'dayjs'

type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

type Logger = {
    [K in LogLevel]: (...args: any[]) => void;
}

export const logger: Logger = {
    fatal: () => void 0,
    error: () => void 0,
    warn: () => void 0,
    info: () => void 0,
    debug: () => void 0,
};

const logDir = resolve(__dirname, '../log');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const logLevelFiles = {
    fatal: 'fatal.log',
    error: 'error.log',
    warn: 'warn.log',
    info: 'info.log',
    debug: 'debug.log',
}

const loggerStdout = (...args: any[]) => console.log(...args);

// 仅对控制台输出做颜色渲染（文件落盘保持纯文本，方便 grep/分析）
const levelColor = {
    fatal: '\x1b[91m', // 亮红
    error: '\x1b[31m', // 红
    warn: '\x1b[33m',  // 黄
    info: '\x1b[32m',  // 绿
    debug: '\x1b[93m', // 浅黄
} satisfies Record<LogLevel, string>;

const colorize = (level: LogLevel, text: string) => {
    // 非 TTY 环境（比如 pm2 重定向）不强制上色，避免控制字符污染日志
    if (!process.stdout?.isTTY) return text;
    const reset = '\x1b[0m';
    return `${levelColor[level]}${text}${reset}`;
};

// create log files if not exist
for (const [logLevel, logFile] of Object.entries(logLevelFiles)) {
    const logFilePath = resolve(logDir, dayjs(Date.now()).format('YYYY-MM-DD'), logFile);
    if (!fs.existsSync(logFilePath)) {
        const logFileDir = parse(logFilePath).dir;
        fs.mkdirSync(logFileDir, { recursive: true });
        fs.writeFileSync(logFilePath, '');
    }
    logger[logLevel as LogLevel] = (...args: any[]) => {
        const stream = fs.createWriteStream(logFilePath, {
            flags: 'a' 
        });
        stream.write(`${dayjs(Date.now()).format('YYYY-MM-DD HH:mm:ss')} `);
        stream.write('\n' + args.join(' ') + '\n');

        // 控制台输出带颜色：info=绿，warn=黄，error=红，debug=浅黄（fatal=亮红）
        const stdoutText = args.map(String).join(' ');
        loggerStdout(colorize(logLevel as LogLevel, stdoutText));
        stream.end();
    };
}
