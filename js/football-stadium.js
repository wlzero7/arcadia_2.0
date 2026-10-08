import * as THREE from "../assets/vendor/three.module.js";

const FORMATION = [[-47,0],[-29,-24],[-33,-8],[-33,8],[-29,24],[-10,-19],[-14,0],[-10,19],[19,-23],[25,0],[19,23]];
export function create(stage) {
    stage.classList.add("football-stadium");
    stage.replaceChildren();
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "Estadio de futebol, campo e jogadores");
    canvas.setAttribute("role", "img");
    canvas.tabIndex = 0;
    const hud = document.createElement("div"); hud.className = "football-score";
    const homeName = document.createElement("strong"), score = document.createElement("b"), awayName = document.createElement("strong");
    const clock = document.createElement("span"); clock.className = "football-minute";
    hud.append(homeName, score, awayName, clock);
    const ticker = document.createElement("div"); ticker.className = "football-ticker"; ticker.setAttribute("role", "status");
    const tools = document.createElement("div"); tools.className = "football-camera";
    stage.append(canvas, hud, ticker, tools);
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true }); }
    catch {
        canvas.remove();
        const fallback=document.createElement("p");fallback.className="football-webgl-fallback";
        fallback.textContent="Estadio 3D indisponivel neste dispositivo. Placar ao vivo mantido.";
        stage.append(fallback);
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#101719");
    const camera = new THREE.PerspectiveCamera(48, 1, .1, 500);
    scene.add(new THREE.HemisphereLight(0xeefaff, 0x233824, 2.5));
    const sunlight = new THREE.DirectionalLight(0xfff4dd, 3); sunlight.position.set(-35, 75, 40); scene.add(sunlight);
    const materials = new Set(), geometries = new Set(), textures = new Set();
    const material = (color) => { const m = new THREE.MeshStandardMaterial({ color, roughness: .85 }); materials.add(m); return m; };
    function mesh(geometry, mat, x = 0, y = 0, z = 0, parent = scene) {
        geometries.add(geometry);
        const item = new THREE.Mesh(geometry, mat); item.position.set(x, y, z); parent.add(item); return item;
    }
    const white = material("#eef6f1"), dark = material("#202729"), skin = material("#c79a76");
    const green = [material("#28864b"), material("#319651")];
    mesh(new THREE.BoxGeometry(126, 1, 88), material("#245737"), 0, -.65);
    for (let i = 0; i < 14; i++) mesh(new THREE.BoxGeometry(105 / 14, .1, 68), green[i % 2], -52.5 + (i + .5) * 105 / 14, 0);
    function line(points) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x,z]) => new THREE.Vector3(x,.12,z)));
        geometries.add(geometry);
        const mat = new THREE.LineBasicMaterial({ color: 0xebfff0 }); materials.add(mat);
        scene.add(new THREE.Line(geometry, mat));
    }
    line([[-52.5,-34],[52.5,-34],[52.5,34],[-52.5,34],[-52.5,-34]]);
    line([[0,-34],[0,34]]);
    line(Array.from({ length: 65 }, (_, i) => [Math.cos(i / 64 * Math.PI * 2) * 9.15, Math.sin(i / 64 * Math.PI * 2) * 9.15]));
    for (const direction of [-1,1]) {
        const x = direction * 52.5;
        line([[x,-20.16],[x-direction*16.5,-20.16],[x-direction*16.5,20.16],[x,20.16]]);
        line([[x,-9.16],[x-direction*5.5,-9.16],[x-direction*5.5,9.16],[x,9.16]]);
        for (const z of [-3.66,3.66]) mesh(new THREE.CylinderGeometry(.15,.15,3.3,8), white, x,1.6,z);
        const crossbar = mesh(new THREE.CylinderGeometry(.15,.15,7.32,8), white, x,3.2); crossbar.rotation.x = Math.PI / 2;
        const netMat = new THREE.MeshBasicMaterial({ color: "#d6dfdb", transparent: true, opacity: .45, wireframe: true }); materials.add(netMat);
        mesh(new THREE.BoxGeometry(2.6,3.1,7.3,3,5,10),netMat,x+direction*1.3,1.5);
    }
    for (const side of [-1,1]) for (let row = 0; row < 6; row++) {
        mesh(new THREE.BoxGeometry(124,2,2.8),material(row%2?"#44585a":"#344346"),0,row*1.1+1,side*(40+row*3));
    }
    const crowdGeometry = new THREE.BoxGeometry(.6,.85,.65); geometries.add(crowdGeometry);
    const crowdMaterial = material("#dfecf0");
    const crowd = new THREE.InstancedMesh(crowdGeometry,crowdMaterial,1440);
    const dummy = new THREE.Object3D(), palette = ["#fa5b63","#ccd8df","#31c39a","#e1c760","#67b1e7"];
    let instance = 0;
    for (const side of [-1,1]) for (let row=0;row<6;row++) for(let seat=0;seat<120;seat++) {
        dummy.position.set(-58+seat*.98,row*1.1+2.4,side*(40+row*3));dummy.updateMatrix();
        crowd.setMatrixAt(instance,dummy.matrix);crowd.setColorAt(instance,new THREE.Color(palette[(seat+row*7)%palette.length]));instance++;
    }
    scene.add(crowd);
    const ball = mesh(new THREE.SphereGeometry(.65,12,8),white,0,.7);
    const seam = mesh(new THREE.OctahedronGeometry(.66),dark,0,0,0,ball); seam.scale.set(.7,.7,.7);
    let players=[], teamsKey="", match=null, received=performance.now(), serverElapsed=0, frame=0, disposed=false, yaw=0, zoom=1;
    let selection=null, lastEventKey="", lastPaint="", observedMatch=null, lastFinalWhistle=null;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    function jersey(player, color) {
        const image = document.createElement("canvas"); image.width=256; image.height=256;
        const ctx=image.getContext("2d");ctx.fillStyle=color;ctx.fillRect(0,0,256,256);
        ctx.textAlign="center";ctx.fillStyle="#ffffff";ctx.font="bold 23px Arial";
        ctx.fillText(player.shirtName,128,50,238);ctx.font="bold 128px Arial";ctx.fillText(player.number,128,184);
        const texture = new THREE.CanvasTexture(image); texture.colorSpace=THREE.SRGBColorSpace;textures.add(texture);
        const mat = new THREE.MeshBasicMaterial({ map:texture, side:THREE.DoubleSide });materials.add(mat);
        return mat;
    }
    function rebuild(home,away) {
        const key=JSON.stringify([home,away]);
        if(key===teamsKey)return;
        teamsKey=key;
        for(const p of players){
            scene.remove(p.group);
            p.group.traverse(item=>{if(item.geometry){item.geometry.dispose();geometries.delete(item.geometry);}});
        }
        // Team changes are rare; release per-player textures before creating the next squad.
        const released=new Set(players.flatMap(p=>p.privateMaterials));
        for(const mat of released){mat.map?.dispose();textures.delete(mat.map);mat.dispose();materials.delete(mat);}
        players=[];
        for(const [side,team] of [["home",home],["away",away]]) {
            const direction=side==="home"?1:-1;
            const shirt=material(team.color), shorts=material(team.secondary);
            for(let index=0;index<11;index++){
                const player=team.players[index],group=new THREE.Group();
                mesh(new THREE.BoxGeometry(1.65,1.9,.85),shirt,0,2.8,0,group);
                mesh(new THREE.SphereGeometry(.56,10,8),skin,0,4.35,0,group);
                mesh(new THREE.BoxGeometry(1.4,.7,.9),shorts,0,1.7,0,group);
                const legs=[mesh(new THREE.BoxGeometry(.48,1.3,.55),dark,-.43,.8,0,group),mesh(new THREE.BoxGeometry(.48,1.3,.55),dark,.43,.8,0,group)];
                const arms=[mesh(new THREE.BoxGeometry(.38,1.4,.42),shirt,-1,2.8,0,group),mesh(new THREE.BoxGeometry(.38,1.4,.42),shirt,1,2.8,0,group)];
                const print=jersey(player,team.color);
                for(const z of [-.435,.435]){const panel=mesh(new THREE.PlaneGeometry(1.5,1.6),print,0,2.8,z,group);if(z<0)panel.rotation.y=Math.PI;}
                group.position.set(FORMATION[index][0]*direction,0,FORMATION[index][1]*direction);
                group.rotation.y=side==="home"?-Math.PI/2:Math.PI/2;scene.add(group);
                players.push({group,legs,arms,side,index,player,team,base:group.position.clone(),privateMaterials:[print,shirt,shorts]});
            }
        }
        homeName.textContent=home.name;awayName.textContent=away.name;
        homeName.style.borderColor=home.color;awayName.style.borderColor=away.color;
    }
    function resize(){
        const width=Math.max(1,stage.clientWidth),height=Math.max(1,stage.clientHeight);
        if(renderer){renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(width,height,false);}
        camera.aspect=width/height;camera.updateProjectionMatrix();
    }
    const observer=new ResizeObserver(resize);observer.observe(stage);resize();
    function button(icon,title,fn){
        const item=document.createElement("button");item.type="button";item.className="icon-button";item.title=title;item.setAttribute("aria-label",title);
        item.innerHTML='<i data-lucide="'+icon+'"></i>';item.addEventListener("click",fn);tools.append(item);
    }
    button("zoom-in","Aproximar camera",()=>zoom=Math.max(.65,zoom-.1));
    button("zoom-out","Afastar camera",()=>zoom=Math.min(1.35,zoom+.1));
    button("rotate-ccw","Restaurar camera",()=>{yaw=0;zoom=1;selection=null;});
    window.lucide?.createIcons({root:tools});
    let drag=null;
    canvas.addEventListener("pointerdown",(e)=>{drag={x:e.clientX,yaw,moved:false};canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener("pointermove",(e)=>{if(drag){if(Math.abs(e.clientX-drag.x)>5)drag.moved=true;yaw=drag.yaw+(e.clientX-drag.x)*.005;}});
    const raycaster=new THREE.Raycaster();
    canvas.addEventListener("pointerup",(e)=>{
        if(drag&&!drag.moved){
            const rect=canvas.getBoundingClientRect();raycaster.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2),camera);
            const hit=raycaster.intersectObjects(players.map(p=>p.group),true)[0];
            selection=hit?players.find(p=>p.group===hit.object.parent):null;
        }
        drag=null;
    });
    canvas.addEventListener("pointercancel",()=>drag=null);
    canvas.addEventListener("keydown",(e)=>{
        if(["ArrowLeft","ArrowRight","+","-","0"].includes(e.key))e.preventDefault();
        if(e.key==="ArrowLeft")yaw-=.1;if(e.key==="ArrowRight")yaw+=.1;
        if(e.key==="+")zoom=Math.max(.65,zoom-.1);if(e.key==="-")zoom=Math.min(1.35,zoom+.1);
        if(e.key==="0"){yaw=0;zoom=1;selection=null;}
    });
    function live(play,serverTime=Date.now()){
        if(disposed)return;
        match=play;received=performance.now();
        serverElapsed=play.ended?play.durationMs:Math.max(0,serverTime-play.startedAt);
        if (!play.ended && observedMatch!==play.id) {
            observedMatch=play.id;
            if(serverElapsed<1200 && typeof Sfx!=="undefined") Sfx.whistle();
        }
        rebuild(play.home,play.away);paint();
    }
    function preview(home,away){if(disposed)return;match=null;serverElapsed=0;rebuild(home,away);score.textContent="0 : 0";clock.textContent="Pre-jogo";ticker.textContent="ARCADIA ARENA";}
    function paint(){
        if(!match)return;
        const elapsed=Math.min(match.durationMs,serverElapsed+(match.ended?0:performance.now()-received));
        if(elapsed>=match.durationMs && observedMatch===match.id && lastFinalWhistle!==match.id) {
            lastFinalWhistle=match.id;
            if(typeof Sfx!=="undefined") Sfx.whistle();
        }
        const available=match.events||[];
        const event=available.findLast(e=>e.at<=elapsed);
        // Never infer an unseen goal from a shot: only the server's goal events change the score.
        const shown=available.filter(e=>e.at<=elapsed);
        const goals=[shown.filter(e=>e.type==="goal"&&e.team==="home").length,shown.filter(e=>e.type==="goal"&&e.team==="away").length];
        score.textContent=goals.join(" : ");
        clock.textContent=match.ended?"Encerrado":Math.min(90,Math.floor(elapsed/match.durationMs*90))+"'";
        const key=match.id+":"+(event?.at??-1);
        if(key!==lastEventKey){
            lastEventKey=key;lastPaint=event?({pass:"Passe",shot:"Chute",goal:"GOL",save:"Defesa"}[event.type])+" · "+event.player+" #"+event.number:"Bola em jogo";
            if(event && !match.ended && elapsed-event.at<1200 && typeof Sfx!=="undefined") {
                if(event.type==="goal") Sfx.footballGoal();
                else if(event.type==="pass" || event.type==="shot" || event.type==="save") Sfx.footballKick(event.type==="shot");
            }
        }
        ticker.textContent=selection?selection.player.name+" · #"+selection.player.number+" · "+selection.player.position+" · "+selection.player.rating+" OVR":lastPaint;
        const t=elapsed/1000;
        for(const p of players){
            const moving=!match.ended&&!reduced;
            const wave=moving?Math.sin(t*2+p.index)*1.8:0;
            p.group.position.set(p.base.x+wave,0,p.base.z+(moving?Math.cos(t+p.index)*1.2:0));
            const active=event?.team===p.side&&event?.from===p.index;
            p.group.position.y=active&&event.type==="goal"&&!reduced?Math.abs(Math.sin(t*8))*.9:0;
            p.legs.forEach((leg,i)=>leg.rotation.x=moving?Math.sin(t*9+i*Math.PI+p.index)*.5:0);
            p.arms.forEach((arm,i)=>arm.rotation.z=active&&event.type==="goal"?(i?1:-1)*1.9:Math.sin(t*5+i*Math.PI)*.1);
        }
        if(event){
            const actor=players.find(p=>p.side===event.team&&p.index===event.from);
            const target=players.find(p=>p.side===event.team&&p.index===event.to);
            const from=actor?.group.position||new THREE.Vector3();
            let to=target?.group.position||new THREE.Vector3();
            if(event.type==="shot"||event.type==="goal")to=new THREE.Vector3(event.team==="home"?52.5:-52.5,.7,Math.sin(event.at)*2.7);
            if(event.type==="save")to=new THREE.Vector3(event.team==="home"?47:-47,.7,0);
            const progress=reduced?1:Math.min(1,Math.max(0,(elapsed-event.at)/(event.until-event.at)));
            ball.position.lerpVectors(from,to,progress);ball.position.y=.7+Math.sin(progress*Math.PI)*(event.type==="shot"?3:1.2);
            ball.rotation.z=-t*4;
        }
    }
    let lastFrame=0;
    function tick(now=performance.now()){
        if(disposed)return;frame=requestAnimationFrame(tick);
        if(now-lastFrame<33 || document.hidden)return;
        lastFrame=now;
        const framing=Math.max(1,1.55/camera.aspect),distance=104*framing*zoom;
        camera.position.set(Math.sin(yaw)*distance,78*framing*zoom,Math.cos(yaw)*distance*.72);
        camera.lookAt(0,0,0);paint();
        renderer?.render(scene,camera);
    }
    tick();
    return {live,preview,round(result){live(result.detail?.home?result.detail:result,Date.now());return Promise.resolve();},destroy(){
        disposed=true;cancelAnimationFrame(frame);observer.disconnect();
        geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());renderer?.dispose();
        stage.classList.remove("football-stadium");stage.replaceChildren();
    }};
}
