window.ArcadiaVisuals = (() => {
    const WHEEL = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
    const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
    const PIPS = {1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
    function diceFace(element, value) {
        element.replaceChildren(...Array.from({length:9}, (_, index) => { const dot=document.createElement("span"); dot.className="dice-pip"; dot.style.visibility=(PIPS[value] || PIPS[1]).includes(index) ? "visible" : "hidden"; return dot; }));
        element.setAttribute("aria-label", "Dado: " + value);
    }
    function wheel(canvas) {
        const ctx=canvas.getContext("2d"), cx=160, radius=154;
        ctx.clearRect(0,0,320,320);
        WHEEL.forEach((number,index) => {
            const start=index*Math.PI*2/37-Math.PI/2, end=(index+1)*Math.PI*2/37-Math.PI/2;
            ctx.beginPath(); ctx.moveTo(cx,cx); ctx.arc(cx,cx,radius,start,end); ctx.closePath(); ctx.fillStyle=number===0?"#167760":RED.has(number)?"#a8273d":"#23242a"; ctx.fill();
            ctx.save(); ctx.translate(cx,cx); ctx.rotate((start+end)/2); ctx.fillStyle="#fff"; ctx.font="bold 11px Arial"; ctx.textAlign="center"; ctx.fillText(String(number),130,4); ctx.restore();
        });
        ctx.beginPath(); ctx.arc(cx,cx,100,0,Math.PI*2); ctx.fillStyle="#121317"; ctx.fill(); ctx.strokeStyle="#c0a273"; ctx.lineWidth=3; ctx.stroke();
    }
    function create(stage, game) {
        let generation=0, frame=0, activeId=null, wheelTurns=0;
        const sounds=typeof Sfx!=="undefined"?Sfx:null;
        const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (game==="dice") { stage.innerHTML='<div class="visual-dice-scene"><div class="visual-dice" role="img"></div></div>'; diceFace(stage.querySelector(".visual-dice"),1); }
        if (game==="coinflip") stage.innerHTML='<div class="visual-coin-scene"><img class="visual-coin" src="css/coin-heads.svg" alt="Moeda: cara"></div>';
        if (game==="slots") stage.innerHTML='<div class="visual-slot-machine"><div class="slot-marquee">ARCADIA</div><div class="visual-reels"><span>7</span><span>7</span><span>7</span></div><div class="slot-indicator">JACKPOT</div></div>';
        if (game==="roulette") { stage.innerHTML='<div class="visual-wheel-scene"><span class="wheel-pointer" aria-hidden="true"></span><canvas class="visual-wheel" width="320" height="320" role="img" aria-label="Roleta europeia"></canvas><strong class="wheel-number">0</strong></div>'; wheel(stage.querySelector("canvas")); }
        if (game==="crash") stage.innerHTML='<div class="visual-crash-scene"><canvas width="600" height="260" role="img" aria-label="Multiplicador do Crash"></canvas><strong class="visual-multiplier">1.00x</strong><span class="visual-crash-state">Pronto para decolar</span></div>';
        function paintCrash(multiplier,state="Em voo") {
            const canvas=stage.querySelector("canvas"), ctx=canvas.getContext("2d");
            ctx.clearRect(0,0,600,260); ctx.strokeStyle="#30323b"; ctx.lineWidth=1;
            for(let x=40;x<600;x+=80){ctx.beginPath();ctx.moveTo(x,20);ctx.lineTo(x,230);ctx.stroke();}
            for(let y=30;y<250;y+=50){ctx.beginPath();ctx.moveTo(40,y);ctx.lineTo(580,y);ctx.stroke();}
            const progress=Math.min(.98,Math.log(Math.max(1,multiplier))/Math.log(10));
            ctx.beginPath();ctx.moveTo(40,230);ctx.bezierCurveTo(150,230,350,230-progress*150,40+progress*530,230-progress*200);ctx.strokeStyle=state==="Explodiu"?"#fb7185":"#22d3ee";ctx.lineWidth=5;ctx.stroke();
            ctx.fillStyle="#f8fafc";ctx.beginPath();ctx.arc(40+progress*530,230-progress*200,6,0,Math.PI*2);ctx.fill();
            stage.querySelector(".visual-multiplier").textContent=multiplier.toFixed(2)+"x";
            stage.querySelector(".visual-crash-state").textContent=state;
        }
        if(game==="crash") paintCrash(1,"Pronto para decolar");
        const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,reduced?0:ms));
        async function round(result) {
            const token=++generation; cancelAnimationFrame(frame); activeId=null;
            const valid=()=>generation===token && stage.isConnected;
            if(game==="dice") {
                const die=stage.querySelector(".visual-dice"); die.classList.add("rolling"); sounds?.dice();
                for(let n=0;n<8;n++){if(!valid())return;diceFace(die,1+Math.floor(Math.random()*6));await wait(90);}
                if(!valid())return; die.classList.remove("rolling");diceFace(die,Number(result.roll ?? result.detail?.roll));
            } else if(game==="coinflip") {
                const coin=stage.querySelector("img");coin.classList.add("spinning");sounds?.coin();await wait(1000);if(!valid())return;
                const side=result.flip || result.detail?.flip || "heads"; coin.classList.remove("spinning");coin.src="css/coin-"+side+".svg";coin.alt="Moeda: "+(side==="heads"?"cara":"coroa");
            } else if(game==="slots") {
                const symbols=["🍒","🍋","🔔","💎","7"], reels=[...stage.querySelectorAll(".visual-reels span")];sounds?.spinSlots();
                reels.forEach(reel=>reel.classList.add("spinning"));
                for(let n=0;n<9;n++){if(!valid())return;reels.forEach(reel=>reel.textContent=symbols[Math.floor(Math.random()*symbols.length)]);await wait(90);}
                for(let n=0;n<3;n++){if(!valid())return;reels[n].classList.remove("spinning");reels[n].textContent=(result.reels || result.detail?.reels || ["7","7","7"])[n];sounds?.reelStop(n);await wait(200);}
                stage.querySelector(".slot-indicator").textContent=result.jackpot?"JACKPOT!":result.outcome==="win"?"VITÓRIA":"ARCADIA";
            } else if(game==="roulette") {
                const canvas=stage.querySelector("canvas"), number=Number(result.number ?? result.detail?.number ?? 0);sounds?.spin();
                wheelTurns+=1440;
                canvas.style.transition=reduced?"none":"transform 1.5s cubic-bezier(.16,.7,.2,1)";canvas.style.transform="rotate("+(wheelTurns-WHEEL.indexOf(number)*360/37-180/37)+"deg)";
                stage.querySelector(".wheel-number").textContent="…";await wait(1500);if(!valid())return;stage.querySelector(".wheel-number").textContent=number;
            } else if(game==="crash") {
                paintCrash(Number(result.multiplier || result.crashPoint || 1),result.outcome==="loss"?"Explodiu":"Resgatado");
                if(result.outcome==="loss")sounds?.boom();else sounds?.cashout();
            }
            if(valid() && result.outcome==="win" && game!=="crash")sounds?.win?.();
        }
        function live(play,serverTime) {
            if(game!=="crash")return;
            if(activeId!==play.id){generation++;activeId=play.id;}
            cancelAnimationFrame(frame);
            const received=performance.now(), base=Math.max(1,play.multiplier), target=play.autoCashout;
            function tick(){if(activeId!==play.id)return;const elapsed=Math.min(.25,(performance.now()-received)/1000);const value=base*Math.exp(elapsed*.16);paintCrash(target?Math.min(value,target):value,play.playerName+" · Em voo");frame=requestAnimationFrame(tick);}
            tick();
        }
        return { game, round, live, destroy(){generation++;activeId=null;cancelAnimationFrame(frame);} };
    }
    function chart(canvas,history) {
        const context=canvas.getContext("2d"), width=canvas.width, height=canvas.height;
        context.clearRect(0,0,width,height);context.strokeStyle="#34363d";context.lineWidth=1;
        for(let y=20;y<height;y+=30){context.beginPath();context.moveTo(0,y);context.lineTo(width,y);context.stroke();}
        const values=history.slice(-20).map(round=>Number(round.payout || 0)-Number(round.wager || 0));
        const max=Math.max(1,...values.map(Math.abs)), slot=width/Math.max(values.length,1);
        values.forEach((value,index)=>{const bar=value/max*(height/2-10);context.fillStyle=value>=0?"#22d3ee":"#fb7185";context.fillRect(index*slot+3,value>=0?height/2-bar:height/2,Math.max(2,slot-6),Math.max(2,Math.abs(bar)));});
        const total=values.reduce((sum,value)=>sum+value,0);return (total>=0?"+":"")+total.toLocaleString("pt-BR")+" AC";
    }
    return {create,chart,diceFace};
})();
