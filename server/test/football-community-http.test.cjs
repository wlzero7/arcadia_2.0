const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawn}=require("node:child_process"),{once}=require("node:events");
test("Football and Community real HTTP enforce sessions, level gates, moderation ownership and input validation", {skip:process.env.ARCADIA_OFFLINE_TEST==="1"}, async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"arcadia-new-http-")),dbPath=path.join(directory,"test.db");
    const child=spawn(process.execPath,["src/server.js"],{cwd:path.resolve(__dirname,".."),env:{...process.env,NODE_ENV:"test",PORT:"0",JWT_SECRET:"new-features-http-fixture",DB_PATH:dbPath,TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",REQUIRE_PERSISTENT_DB:"0"},stdio:["ignore","pipe","pipe"],windowsHide:true});
    let logs="",db;child.stderr.on("data",chunk=>logs+=chunk);
    try{
        const base=await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error(logs)),15000);
            child.stdout.on("data",chunk=>{logs+=chunk;const port=/http:\/\/localhost:(\d+)/.exec(logs)?.[1];if(port){clearTimeout(timer);resolve("http://127.0.0.1:"+port);}});
            child.once("exit",()=>{clearTimeout(timer);reject(Error(logs));});
        });
        const request=async(url,body,cookie,method=body?"POST":"GET")=>{
            const response=await fetch(base+url,{method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
            return {status:response.status,data:await response.json().catch(()=>null),cookie:response.headers.get("set-cookie")?.split(";")[0]};
        };
        const register=async(name)=>{
            const result=await request("/api/auth/register",{username:name,email:name+"@example.test",password:"FixtureTesting123!"});
            assert.equal(result.status,201);return result;
        };
        const a=await register("newfirst"),b=await register("newsecond");
        const {Database}=require("node-sqlite3-wasm");db=new Database(dbPath);
        assert.equal((await request("/api/games/football/start",{wager:10})).status,401);
        assert.equal((await request("/api/games/football/club")).status,401);
        assert.equal((await request("/api/community/threads?category=discussion")).status,200);
        assert.equal((await request("/api/community/threads?category=feedback")).status,401);
        const feedback={category:"feedback",title:"Ideia para a arena",body:"Quero sugerir uma melhoria para as partidas de futebol."};
        assert.equal((await request("/api/community/threads",feedback,a.cookie)).status,403);
        db.run("UPDATE users SET level=5 WHERE id=?",[a.data.user.id]);
        const thread=await request("/api/community/threads",feedback,a.cookie);assert.equal(thread.status,200);
        const url="/api/community/threads/"+thread.data.id;
        assert.equal((await request(url,null,b.cookie)).status,403);
        assert.equal((await request(url+"/replies",{body:"Nao posso acessar"},b.cookie)).status,403);
        assert.equal((await request(url+"/like",{liked:true},b.cookie)).status,403);
        assert.equal((await request(url+"/like",{liked:true},a.cookie)).status,200);
        assert.equal((await request(url+"/like",{liked:true},a.cookie)).status,200);
        assert.equal(db.get("SELECT COUNT(*) AS n FROM community_likes").n,1);
        assert.equal((await request(url,{action:"remove",reason:"Nao autorizado"},b.cookie,"PATCH")).status,403);
        assert.equal((await request(url,{action:"close",reason:"Teste concluido"},a.cookie,"PATCH")).status,200);
        assert.equal((await request(url+"/replies",{body:"Fechado nao permite"},a.cookie)).status,409);
        assert.equal(db.get("SELECT COUNT(*) AS n FROM community_moderation").n,1);
        const list=await request("/api/community/threads?category=feedback&search=%27%20OR%201%3D1",null,a.cookie);
        assert.equal(list.status,200);assert.deepEqual(list.data.items,[]);
        for(const row of (await request("/api/community/threads?category=feedback",null,a.cookie)).data.items){
            assert.equal(row.password_hash,undefined);assert.equal(row.email,undefined);
        }
        const invalid=await request("/api/games/football/start",{wager:10,choice:{home:"aurora",away:"aurora",picked:"home"}},a.cookie);assert.equal(invalid.status,400);
        assert.equal((await request("/api/wallet",null,a.cookie)).data.balance,1000000);
        const started=await request("/api/games/football/start",{wager:10,choice:{home:"aurora",away:"bairro",picked:"home"}},a.cookie);
        assert.equal(started.status,200);assert.equal(started.data.match.winner,undefined);assert.equal(started.data.match.timeline,undefined);
        const outsider=await request("/api/games/football/state",null,b.cookie);assert.equal(outsider.data.match,null);
        assert.equal((await request("/api/games/football/start",{allWin:true,choice:{home:"aurora",away:"bairro",picked:"home"}},a.cookie)).status,400);
        for(const url of ["/football.html","/comunidade.html","/js/football-stadium.js","/assets/vendor/three.module.js","/assets/vendor/three.core.js"])assert.equal((await fetch(base+url)).status,200);
        assert.equal((await fetch(base+"/server/.env.turso-test")).status,404);
    }finally{
        db?.close();const exited=once(child,"exit").catch(()=>{});child.kill();await exited;
        fs.rmSync(directory,{recursive:true,force:true});
    }
});
