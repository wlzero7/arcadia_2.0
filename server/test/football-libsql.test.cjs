const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawn}=require("node:child_process");
test("Football and Community run against the production libSQL adapter with isolated files", {skip:process.env.ARCADIA_OFFLINE_TEST==="1"},async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"arcadia-libsql-football-"));
    try{
        const env={...process.env,ARCADIA_LIBSQL_TEST:"1",ARCADIA_TEST_DIRECTORY:directory};
        delete env.NODE_TEST_CONTEXT;
        const child=spawn(process.execPath,["--test","test/football.test.cjs","test/community.test.cjs"],{cwd:path.resolve(__dirname,".."),env,stdio:["ignore","pipe","pipe"],windowsHide:true});
        let output="";child.stdout.on("data",data=>output+=data);child.stderr.on("data",data=>output+=data);
        const code=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});
        assert.equal(code,0,output);
        assert.match(output,/pass 22/);
    }finally{
        assert.equal(path.dirname(directory),os.tmpdir());
        fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
});
