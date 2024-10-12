import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { games, protocols } from 'gamedig';

import 'dotenv/config';
import { GameServerConfig, readConfig, updateConfig, Watcher } from './watcher.js';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const gamedigPjson = fs.readFileSync(path.resolve(__dirname, '../node_modules/gamedig/package.json'), 'utf-8');
const gamedigVersion = JSON.parse(gamedigPjson).version || '0';

const gswPjson = fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8');
const gswVersion = JSON.parse(gswPjson).version || '0';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '8080', 10);
const SECRET = process.env.SECRET || 'secret';
const DBG = Boolean(Number(process.env.DBG));

interface ApiResponse extends FeaturesResponse, ConfigResponse {
    message?: string;
    error?: string;
}

interface FeaturesResponse{
    versions?: {
        gsw: string;
        gamedig: string;
    }
    services?: {
        steam: boolean;
        discord: boolean;
        telegram: boolean;
        slack: boolean;
    };
    debug?: boolean;
}

interface ConfigResponse{
    config?: GameServerConfig[];
}

interface SelectOptionsResponse {
    options: {
        enum_titles: string[];
    };
    enum: string[];
}

const EXT_MIME: Record<string, string> = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png'
};

// Start Watcher service
const watcher = new Watcher();
watcher.start();

// Start Control Panel service
createServer(async (req, res) => {
    if (DBG) console.log('DBG: %j %j', (new Date()), req.url);

    try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const p = req.url === '/' ? 'index.html' : reqUrl.pathname.slice(1);
        const ext = path.extname(p).slice(1);

        if (ext in EXT_MIME && !p.includes('/') && !p.includes('\\')) {
            if (SECRET !== '') {
                const filePath = path.resolve('./public/', p);
                if (fs.existsSync(filePath)) {
                    res.writeHead(200, {
                        'Content-Type': EXT_MIME[ext] || 'plain/text'
                    });
                    fs.createReadStream(filePath).on('error', (err: any) => {
                        console.error(err?.message || err);
                        res.end();
                    }).pipe(res);
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    res.end('<html><head></head><body>404 &#x1F4A2</body></html>');
                }
            } else {
                res.end('Configure the `SECRET` env var to enable the web UI!');
            }
        } else if (p === 'ping') {
            if (DBG) console.log('ping');
            res.end('pong');
        } else if (p === 'gamedig-games') {
            const gdProtocols = Object.keys(protocols).map(p => `protocol-${p}`);
            const gdGameTypes = [];
            const gdGamesNames = [];

            for (const [type, g] of Object.entries(games)) {
                gdGameTypes.push(type);
                gdGamesNames.push(g.name + ' (' + g.release_year + ')');
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'max-age=0'
            });

            res.end(JSON.stringify({
                enum: [...gdGameTypes, ...gdProtocols],
                options: {
                    enum_titles: [...gdGamesNames, ...gdProtocols]
                }
            } as SelectOptionsResponse, null, DBG ? 2 : 0));
        } else if (SECRET !== '' && req.headers['x-btoken']) {
            let status = 200;
            let re: ApiResponse = {};

            if (validateBearerToken(String(req.headers['x-btoken']))) {
                const reqPath = p.split('/');
                try {
                    if (reqPath[0] === 'features') {
                        if (DBG) re.debug = true;
                        re.versions = {
                            gsw: String(gswVersion),
                            gamedig: String(gamedigVersion)
                        };
                        re.services = {
                            steam: Boolean(process.env.STEAM_WEB_API_KEY),
                            discord: Boolean(process.env.DISCORD_BOT_TOKEN),
                            telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
                            slack: Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN)
                        };
                    } else if (reqPath[0] === 'config') {
                        if (req.method === 'GET') {
                            re.config = await readConfig();
                        } else if (req.method === 'POST') {
                            const body = await new Promise(resolve => {
                                let body = '';
                                req.on('data', (chunk: string) => {
                                    body += chunk;
                                });
                                req.on('end', () => {
                                    resolve(body);
                                });
                            });

                            // TODO: validate (ajv)
                            await updateConfig(JSON.parse(String(body)) || [] as GameServerConfig[]);
                            await watcher.restart();

                            re.message = 'Configuration updated. Watcher restarted.';
                        } else {
                            status = 400;
                            re.error = 'Invalid Request';
                        }
                    } else if (reqPath[0] === 'flush' && ['servers', 'discord', 'telegram', 'slack'].includes(reqPath[1])) {
                        //TODO: check for and append host:port if available
                        await watcher.restart(reqPath[1]);
                        re.message = '🗑️ ' + reqPath[1].slice(0, 1).toUpperCase() + reqPath[1].slice(1) + ' data flushed.';
                    } else {
                        status = 400;
                        re.error = 'Invalid Request';
                    }
                } catch (err: any) {
                    status = 500;
                    re.error = err.message || String(err);
                }
            } else {
                status = 401;
                re.error = 'Unauthorized';
            }

            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'max-age=0'
            });

            res.end(JSON.stringify(re, null, DBG ? 2 : 0));
        } else {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><head></head><body>400 &#x1F4A2</body></html>');
        }
    } catch (err: any) {
        if (DBG) console.error(err?.message || err);
        const code = err.message === 'Invalid URL' ? 400 : 500;
        res.writeHead(code, { 'Content-Type': 'text/html' });
        res.end(`<html><head></head><body>${code} &#x1F4A2</body></html>`);
    }
}).listen(PORT, HOST, () => {
    console.log('GSW Control Panel service started %s:%s', HOST, PORT);
});

function validateBearerToken(btoken: string) {
    const salt = btoken.slice(0, btoken.length - 141);
    const valid = btoken.slice(-141, -128);
    const hash = btoken.slice(-128);

    if (DBG) console.log('validateBT', valid, salt);
    if (salt.length > 24
        && /^\d{13}$/.test(valid)
        && /^[a-f0-9]{128}$/.test(hash)
        && Date.now() < Number(valid)) {
        return hash === crypto.createHash('sha512').update(salt + valid + SECRET).digest('hex');
    }

    return false;
}
