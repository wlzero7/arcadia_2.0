const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-coop-avatar-"));
process.env.DB_PATH = path.join(directory, "game.db");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "local-test-only";
const { FakeIO } = require("./support.cjs");
const pool = require("../src/config/database");
const avatars = require("../src/services/avatars");
const { setupMultiplayer, rooms, roomSummary, hydrateRooms } = require("../src/realtime/rooms");
let realtime;
function user(name) {
    const id = pool.db.run("INSERT INTO users (username,email,password_hash) VALUES (?,?,?)", [name,name+"@example.test","hash"]).lastInsertRowid;
    for(const kind of ["solo","duel","coop"]) pool.getWalletSync(id,kind);
    return id;
}
test("avatars reject internal networks, normalize files and persist canonical bytes", async () => {
    for(const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","192.168.1.1","172.16.0.1","::1","fc00::1","::ffff:127.0.0.1"]) assert.equal(avatars.publicAddress(ip),false,ip);
    assert.equal(avatars.publicAddress("8.8.8.8"),true);
    await assert.rejects(avatars.downloadImage("http://example.com/a.png"));
    await assert.rejects(avatars.downloadImage("https://127.0.0.1/a.png"));
    const sharp = require("sharp");
    const input = await sharp({create:{width:400,height:200,channels:3,background:"red"}}).png().toBuffer();
    const image = await avatars.normalizeImage(input);
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.width,256);assert.equal(metadata.height,256);assert.equal(metadata.format,"webp");
    await assert.rejects(avatars.normalizeImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'></svg>")));
    await assert.rejects(avatars.normalizeImage(Buffer.from("not an image")));
    const id=user("avatar_test");const url=avatars.saveImage(id,image);
    assert.match(url,/^\/api\/avatars\/\d+\?v=[a-f0-9]{16}$/);
    assert.equal(avatars.identity(id).avatar,url);
    assert.deepEqual(Buffer.from(pool.db.get("SELECT image FROM avatar_images WHERE user_id=?",[id]).image),image);
    pool.db.run("DELETE FROM users WHERE id=?",[id]);assert.ok(!pool.db.get("SELECT user_id FROM avatar_images WHERE user_id=?",[id]));
});
test("Coop Crash keeps its secret, escrows the pot, restores and settles only once", () => {
    const io = new FakeIO();realtime=setupMultiplayer(io);
    const first=user("coop_first"),second=user("coop_second");
    const a=io.connect(first),b=io.connect(second);
    const created=a.call("room:create",{game:"crash"});assert.equal(created.ok,true);
    b.call("room:join",{code:created.room.code});a.call("room:stake",{amount:1000});b.call("room:stake",{amount:1000});
    const played=a.call("room:play",{wager:100,choice:{autoCashout:null}});assert.equal(played.ok,true);
    const room=rooms.get(created.room.code);assert.equal(room.pot,1900);
    assert.equal(roomSummary(room).activePlay.crashPoint,undefined);
    assert.equal(a.call("room:withdraw").ok,false);assert.equal(b.call("room:play",{wager:100}).ok,false);
    assert.equal(b.call("room:cashout").ok,false);
    room.activePlay.crashPoint=10;
    room.activePlay.startedAt=Date.now()-3000;
    const current=a.call("room:cashout");assert.equal(current.ok,true);assert.ok(current.round.payout>100);
    const pot=room.pot;assert.equal(a.call("room:cashout").ok,false);assert.equal(room.pot,pot);
    assert.equal([...room.stakes.values()].reduce((sum,n)=>sum+n,0),room.pot);
    a.call("room:play",{wager:10});rooms.clear();hydrateRooms();assert.ok(rooms.get(created.room.code).activePlay);
    assert.equal(roomSummary(rooms.get(created.room.code)).activePlay.crashPoint,undefined);
});
test("Coop Crash rolls back a failed cashout and automatically recovers after disconnect/reload", async () => {
    const io=new FakeIO();const controller=setupMultiplayer(io);
    const id=user("crash_recovery");const socket=io.connect(id);
    const created=socket.call("room:create",{game:"crash"});const room=rooms.get(created.room.code);
    socket.call("room:stake",{amount:100});
    const started=socket.call("room:play",{wager:10,choice:{autoCashout:2}});assert.equal(started.ok,true);
    room.activePlay.crashPoint=10;room.activePlay.startedAt=Date.now()-6000;
    const history=room.history.length, balance=room.pot;
    const originalRun=pool.db.run;
    pool.db.run=function(sql,params){if(sql.startsWith("UPDATE room_pot"))throw Error("simulated persistence failure");return originalRun.call(this,sql,params);};
    try { assert.equal(socket.call("room:cashout").ok,false); }
    finally { pool.db.run=originalRun; }
    assert.equal(room.pot,balance);assert.equal(room.history.length,history);assert.ok(room.activePlay);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?",[id]).n,0);
    // Persist the deterministic test clock/point before simulating rehydration.
    pool.db.run("UPDATE room_pot SET active_play=? WHERE room_id=?",[JSON.stringify(room.activePlay),room.id]);
    socket.disconnect();rooms.clear();hydrateRooms();
    const restored=rooms.get(created.room.code);
    assert.ok(restored.activePlay);assert.equal(roomSummary(restored).players[0].online,false);
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(restored.activePlay,null);assert.equal(restored.pot,110);
    assert.equal(restored.history.at(-1).payout,20);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?",[id]).n,1);
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(restored.pot,110);assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?",[id]).n,1);
    controller.close();
});
test("libSQL driver persists users and BLOBs across processes and rolls transactions back", () => {
    const file=path.join(directory,"remote-driver.db");
    const source=`process.env.TURSO_DATABASE_URL=require('node:url').pathToFileURL(${JSON.stringify(file)}).href;process.env.NODE_ENV='test';const p=require('./src/config/database');
        const id=p.transactionSync(()=>p.db.run("INSERT INTO users (username,email,password_hash) VALUES ('cloud','cloud@test','hash')").lastInsertRowid);
        p.getWalletSync(id);try{p.transactionSync(()=>{p.db.run('UPDATE wallets SET balance=7 WHERE user_id=?',[id]);throw Error('rollback');});}catch(e){}
        if(p.getWalletSync(id).balance!==1000000)throw Error('rollback failed');
        const batch=p.batchSync([{sql:'INSERT INTO avatar_images VALUES (?,?,?)',params:[id,Buffer.from([1,2,3]),'test']},{method:'get',sql:'SELECT image FROM avatar_images WHERE user_id=?',params:[id]}]);
        if(Buffer.from(batch[1].image).length!==3)throw Error('batch BLOB failed');
        try{p.batchSync([{sql:'UPDATE wallets SET balance=7 WHERE user_id=?',params:[id]},{sql:'INSERT INTO users (username,email,password_hash) VALUES (?,?,?)',params:['cloud','cloud@test','hash']}]);}catch(e){}
        if(p.getWalletSync(id).balance!==1000000)throw Error('batch rollback failed');p.db.close();`;
    let child=spawnSync(process.execPath,["-e",source],{cwd:path.resolve(__dirname,".."),encoding:"utf8",timeout:30000});assert.equal(child.status,0,child.stderr);
    child=spawnSync(process.execPath,["-e",`process.env.TURSO_DATABASE_URL=require('node:url').pathToFileURL(${JSON.stringify(file)}).href;process.env.NODE_ENV='test';const p=require('./src/config/database');if(p.db.get("SELECT COUNT(*) AS n FROM users").n!==1)throw Error('lost user');const a=p.db.get('SELECT image FROM avatar_images');if(Buffer.from(a.image).length!==3)throw Error('lost image');p.db.close();`],{cwd:path.resolve(__dirname,".."),encoding:"utf8",timeout:30000});assert.equal(child.status,0,child.stderr);
});
test("persistent database requirement never silently uses an ephemeral file", () => {
    const child=spawnSync(process.execPath,["-e","require('./src/config/database')"],{cwd:path.resolve(__dirname,".."),env:{...process.env,REQUIRE_PERSISTENT_DB:"1",TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:""},encoding:"utf8"});
    assert.notEqual(child.status,0);assert.match(child.stderr,/Banco persistente obrigatorio/);
});
test.after(()=>{realtime?.close();pool.db.close();});
