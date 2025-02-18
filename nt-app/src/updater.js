// Imports
const got = require("got")
const crypto = require('crypto');
const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');
const { spawn } = require("child_process")
const { app } = require("electron")
function FindGameFolder() {
    return new Promise(res => {
        forcedirSync(app.getPath("userData"))
        const userDataPath = path.join(app.getPath("userData"), "/gamePath.json")
        if (fs.existsSync(userDataPath)) {
            try {
                const gamePath = JSON.parse(fs.readFileSync(userDataPath, 'utf-8'))
                if(fs.existsSync(gamePath)) {
                    res(gamePath)
                    return //don't fall through to autodetection
                }
            } catch (error) {}
        }

        //auto-detect the game path
        if (process.platform === "win32") {
            const gamePaths = []
            const child = spawn("powershell.exe", [
                `
                (Get-Item "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 881100").GetValue("InstallLocation")
                (Get-Item "HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1310457090").GetValue("path")
                `
            ]);
            child.stdout.on("data", function (data) {
                gamePaths.push(data.toString())
            });
            child.stdin.end()
            child.on("error", () => {}) // do nothing on error and let it default to blank on close
            child.on("close", () => {
                let gamePath = gamePaths.shift() || ""
                if (gamePath) { gamePath = gamePath.replace("\r\n", "") }
                fs.writeFileSync(userDataPath, JSON.stringify(gamePath), 'utf-8')
                res(gamePath)
            })
        }
        else if (process.platform === "linux") {
            const linuxPaths = [
                path.join(app.getPath("home"), "/.steam/steam/steamapps/common/Noita"), //steam deck and newer form?
                path.join(app.getPath("home"), "/.local/share/Steam/steamapps/common/Noita/") //somewhat older form under .local/share
                //TODO is there a likely default for GOG installs?
            ]

            let foundNoita = false
            linuxPaths.every(p => {
                if(fs.existsSync(p)) {
                    foundNoita = true
                    fs.writeFileSync(userDataPath, JSON.stringify(p), 'utf-8');
                    res(p)
                    return false;
                }
                return true;
            })

            //didnt find it in those locations
            if(!foundNoita) {
                res("")
            }
        }
        //other/unknown platform fallback
        else
        {
            res("")
        }
    })
}
// Constants
const AutoUpdateServers = ['https://raw.githubusercontent.com/SkyeOfBreeze/noita-together/'];

// Implementation
function forcedirSync(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (_) {
        // Ignore
    }
}

function hash(data) {
    return crypto.createHash('sha256').update(data).digest().toString('hex').toUpperCase();
}

class Updater extends EventEmitter {
    constructor(branch = 'mod', gamePath) {
        super();
        this.setMaxListeners(0);

        this.branch = branch;
        this.gamePath = gamePath || ""
    }

    buildPath(relpath) {
        const p = path.join(this.gamePath, relpath)
        return p;
    }
    buildURL(serverIndex, relpath) {
        return `${AutoUpdateServers[serverIndex]}main/${this.branch}/${relpath}`;
    }
    async downloadRaw(serverIndex, relpath) {
        const url = this.buildURL(serverIndex, relpath)
        return await got(url).buffer();
    }
    async downloadJSON(serverIndex, relpath) {
        const url = this.buildURL(serverIndex, relpath)
        return await got(url).json();
    }

    async check(serverIndex = 0) {
        this.emit('check_start', serverIndex);

        try {
            const manifest = await this.downloadJSON(serverIndex, 'manifest.json');

            let operations = [];
            Object.keys(manifest.files).forEach(relpath => {
                const filedata = manifest.files[relpath];
                const filepath = this.buildPath(relpath);

                let expectedHash = null;
                let needsUpdate = false;
                if (typeof filedata === 'object') {
                    expectedHash = filedata.hash.toUpperCase();

                    if (filedata.overwrite === 'only')
                        needsUpdate = fs.existsSync(filepath) && hash(fs.readFileSync(filepath)) !== expectedHash;
                    else
                        needsUpdate = !fs.existsSync(filepath) || (filedata.overwrite && hash(fs.readFileSync(filepath)) !== expectedHash);
                } else {
                    expectedHash = filedata.toUpperCase();
                    needsUpdate = !fs.existsSync(filepath) || hash(fs.readFileSync(filepath)) !== expectedHash;
                }

                if (needsUpdate)
                    operations.push({
                        type: 'update',
                        hash: expectedHash,
                        relpath,
                        abspath: filepath
                    });
            });

            this.emit('check_success', serverIndex, operations);
            return {
                serverIndex,
                operations
            };
        } catch (e) {
            this.emit('check_fail', serverIndex, e);

            if (serverIndex + 1 < AutoUpdateServers.length) {
                return await this.check(serverIndex + 1);
            } else {
                this.emit('check_fail_all');
                return null;
            }
        }
    }

    async resolveGamePath() {
        if (!this.gamePath) {
            const gamePath = await FindGameFolder()
            if (gamePath) {
                this.gamePath = gamePath
            }
        }
        if (fs.existsSync(path.join(this.gamePath, "/noita.exe"))) {
            let folder = "noita-together"
            if (this.branch == "noita_mod/nemesis") { folder = "noita-nemesis" }
            this.gamePath = path.join(this.gamePath, "/mods/" + folder + "/")
            return true
        }
        else { return false }
    }

    async run(checkResult = null) {
        this.emit('run_start');

        this.emit('gamepath_find');
        const foundGamepath = await this.resolveGamePath()
        if (!foundGamepath) {
            this.emit('gamepath_error')
            return
        }

        const isDevelopment = process.env.NODE_ENV !== 'production'
        if(isDevelopment){
            this.emit('prepare_start');
            this.emit('execute_start');
            var sudo = require('sudo-prompt');
            var options = {
                name: 'Noita Together'
            };
            const dunk = this
            switch (this.branch){
                case 'noita_mod/core':
                    this.emit('download_start', 'Copy mods', 'noita_mod/core');

                    sudo.exec(`node ${path.join(__dirname, '../src/', 'copy-dir.js')} noita_mod/core "${this.gamePath}"`, options,
                        function(error, stdout, stderr) {
                            if (error) {
                                dunk.emit('download_error', 'Copy mods', stdout);
                                throw error;
                            }
                            console.log('stdout: ' + stdout);
                            dunk.emit('download_finish', 'Copy mods', 'noita_mod/core');
                        }
                    );
                    break;
                case 'noita_mod/nemesis':
                    this.emit('download_start', 'Copy mods', 'noita_mod/nemesis');

                    sudo.exec(`node ${path.join(__dirname, '../src/', 'copy-dir.js')} noita_mod/nemesis "${this.gamePath}"`, options,
                        function(error, stdout, stderr) {
                            if (error) {
                                dunk.emit('download_error', 'Copy mods', stdout);
                                throw error;
                            }
                            console.log('stdout: ' + stdout);
                            dunk.emit('download_finish', 'Copy mods', 'noita_mod/nemesis');
                        }
                    );
                    break;
            }
            this.emit('run_finish', true);
            return
        }

        if (!checkResult)
            checkResult = await this.check();

        let success;
        if (checkResult) {
            success = true;

            if (checkResult.operations.length > 0) {
                this.emit('prepare_start');

                // Prepare and validate operations
                for (let operation of checkResult.operations) {
                    if (operation.type === 'update') {
                        this.emit('download_start', checkResult.serverIndex, operation.relpath);
                        operation.data = await this.downloadRaw(checkResult.serverIndex, operation.relpath);
                        if (operation.hash === hash(operation.data)) {
                            this.emit('download_finish', checkResult.serverIndex, operation.relpath);
                        } else {
                            this.emit('download_error', operation.relpath, operation.hash, hash(operation.data));
                            success = false;
                            break;
                        }
                    }
                }

                this.emit('prepare_finish');

                if (success) {
                    this.emit('execute_start');

                    // All operations have been prepared and validated, so execute them now
                    for (let operation of checkResult.operations) {
                        switch (operation.type) {
                            case 'update': {
                                this.emit('install_start', operation.relpath);
                                try {
                                    forcedirSync(path.dirname(operation.abspath));
                                    fs.writeFileSync(operation.abspath, operation.data);
                                    this.emit('install_finish', operation.relpath);
                                } catch (e) {
                                    success = false;
                                    this.emit('install_error', operation.relpath, e);
                                }
                                break;
                            }
                        }
                    }

                    this.emit('execute_finish');
                }
            }
        } else {
            success = false;
        }

        this.emit('run_finish', success);
        return checkResult && checkResult.operations && checkResult.operations.length !== 0;
    }
}

module.exports = Updater;
