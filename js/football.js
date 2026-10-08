(() => {
    const $=(id)=>document.getElementById(id), clubMode=new URLSearchParams(location.search).get("mode")==="duel";
    let catalog, visual, active=false, pending=false, marketValid=false, marketGeneration=0, pollTimer, destroyed=false, club, lastReceipt=null, marketMatch=null;
    const api=(path,body)=>ArcadiaAPI.request("/api/games/football/"+path,body?{method:"POST",body:JSON.stringify(body)}:{});
    const status=(message)=>$("footballStatus").textContent=message;
    const rating=(investment)=>Number(Math.min(96,45+17*Math.log10(1+investment/1000)).toFixed(2));
    function options(select, teams){for(const team of teams)select.add(new Option(team.name,team.id));}
    function lock(){
        $("footballBet").querySelectorAll("input,select,button").forEach(el=>el.disabled=active||pending);
        $("footballStart").disabled=active||pending||!marketValid;
    }
    function rosters(home,away){
        $("footballRosters").replaceChildren();
        for(const team of [home,away]){
            const section=document.createElement("section"),heading=document.createElement("h2"),list=document.createElement("ol");
            heading.textContent=team.name+" · "+team.strength+" OVR";
            for(const player of team.players){
                const row=document.createElement("li"),number=document.createElement("strong"),name=document.createElement("span"),level=document.createElement("b");
                number.textContent=player.number;name.textContent=player.name;level.textContent=player.rating;row.append(number,name,level);list.append(row);
            }
            section.append(heading,list);$("footballRosters").append(section);
        }
    }
    function paintMarket(home,away,prices,picked="home"){
        const container=$("footballMarket");container.replaceChildren();
        const legend=document.createElement("legend");legend.textContent="Resultado final";container.append(legend);
        for(const [key,title] of [["home",home.name],["draw","Empate"],["away",away.name]]){
            const label=document.createElement("label");label.className="football-odd";
            const input=document.createElement("input");input.type="radio";input.name="footballPick";input.value=key;input.checked=key===picked;
            const name=document.createElement("span");name.textContent=title;
            const chance=document.createElement("small");chance.textContent=(prices.probabilities[key]*100).toFixed(1)+"%";name.append(chance);
            const odd=document.createElement("strong");odd.textContent=prices.odds[key].toFixed(2)+"x";
            label.append(input,name,odd);container.append(label);
        }
        marketValid=true;
    }
    async function market(){
        const generation=++marketGeneration;
        marketValid=false;
        pending=true;lock();
        try{
            const data=await api("market?home="+$("homeTeam").value+"&away="+$("awayTeam").value);
            if(generation!==marketGeneration||active||destroyed)return;
            const home=catalog.teams.find(t=>t.id===$("homeTeam").value),away=catalog.teams.find(t=>t.id===$("awayTeam").value);
            paintMarket(home,away,data);
            visual.preview(home,away);rosters(home,away);status("Pre-jogo");
            marketValid=true;
        }catch(error){status(error.message);}
        finally{if(generation===marketGeneration){pending=false;lock();}}
    }
    function show(data){
        active=data.active;
        if(Number.isSafeInteger(data.balance))ArcadiaWallet.setCached(data.balance);
        if(data.match){
            if(marketMatch!==data.match.id){
                marketMatch=data.match.id;marketGeneration++;pending=false;
                $("homeTeam").value=data.match.home.id;$("awayTeam").value=data.match.away.id;$("wager").value=data.match.wager;
                paintMarket(data.match.home,data.match.away,data.match,data.match.picked);
            }
            visual.live(data.match,data.serverTime);
            rosters(data.match.home,data.match.away);
            if(active)status("Partida em andamento · "+data.match.minute+"'");
            else {
                status("Apito final");
                $("footballReceipt").className="football-receipt "+data.match.outcome;
                $("footballReceipt").textContent=data.match.home.name+" "+data.match.score.join(" : ")+" "+data.match.away.name+" · Premio "+ArcadiaWallet.format(data.match.payout);
                if(lastReceipt!==data.match.id){lastReceipt=data.match.id;ArcadiaWallet.refresh().catch(e=>status(e.message));}
            }
        }
        lock();
    }
    async function poll(){
        if(destroyed)return;
        try{const data=await api("state");if(destroyed)return;show(data);if(data.active)pollTimer=setTimeout(poll,1000);}
        catch(error){status(error.message);if(!destroyed)pollTimer=setTimeout(poll,3000);}
    }
    function entries(){
        return [...$("clubPlayers").children].map(row=>({id:row.querySelector("select").value,investment:Number(row.querySelector("input").value)}));
    }
    function clubTotals(){
        const values=entries();let cost=0,total=0;
        values.forEach((entry,index)=>{
            const strength=rating(Math.max(0,entry.investment||0));
            cost+=Math.max(0,(entry.investment||0)-(club.investments[entry.id]||0));total+=strength;
            const row=$("clubPlayers").children[index];row.querySelector(".club-rating span").textContent=strength+" OVR";row.querySelector("meter").value=strength;
        });
        $("clubCost").textContent=ArcadiaWallet.format(cost);$("clubStrength").textContent=(total/11).toFixed(1)+" OVR";
        const skin=catalog.teams.find(t=>t.id===$("clubBrand").value);
        const team={...skin,id:club.team.id,custom:true,name:club.team.name,players:values.map((entry,index)=>({...catalog.players.find(p=>p.id===entry.id),number:index+1,rating:rating(Math.max(0,entry.investment||0))}))};
        // Preview uses saved ratings; unsaved numeric edits remain in the roster table.
        visual.preview({...team,players:club.team.players},catalog.teams[13]);
    }
    function renderClub(data){
        club=data;$("clubBrand").value=club.teamId;ArcadiaWallet.setCached(club.balance);
        $("clubPlayers").replaceChildren();
        club.lineup.forEach((id,index)=>{
            const row=document.createElement("div");row.className="club-row";
            const number=document.createElement("strong");number.textContent=index+1;
            const position=document.createElement("span");position.textContent=catalog.positions[index];
            const select=document.createElement("select");select.setAttribute("aria-label","Jogador "+(index+1));
            for(const player of catalog.players.filter(p=>p.position===catalog.positions[index]))select.add(new Option(player.name,player.id));
            select.value=id;
            const label=document.createElement("label");label.textContent="AC investidos";
            const input=document.createElement("input");input.type="number";input.min=club.investments[id]||0;input.max=1000000;input.step=100;input.value=club.investments[id]||0;input.required=true;input.setAttribute("aria-label","Investimento jogador "+(index+1));label.append(input);
            const strength=document.createElement("div");strength.className="club-rating";const value=document.createElement("span"),meter=document.createElement("meter");meter.min=0;meter.max=100;meter.setAttribute("aria-label","Forca do jogador");strength.append(value,meter);
            row.append(number,position,select,label,strength);$("clubPlayers").append(row);
            select.addEventListener("change",()=>{input.min=club.investments[select.value]||0;input.value=input.min;clubTotals();});
            input.addEventListener("input",clubTotals);
        });
        clubTotals();
    }
    $("footballBet").addEventListener("submit",async e=>{
        e.preventDefault();if(active||pending)return;
        if(!ArcadiaAPI.isLoggedIn()){status("Entre na sua conta para apostar.");return;}
        pending=true;lock();clearTimeout(pollTimer);
        try{show(await api("start",{wager:Number($("wager").value),choice:{home:$("homeTeam").value,away:$("awayTeam").value,picked:document.querySelector('[name="footballPick"]:checked')?.value}}));pollTimer=setTimeout(poll,1000);}
        catch(error){status(error.message);}
        finally{pending=false;lock();}
    });
    $("homeTeam").addEventListener("change",market);$("awayTeam").addEventListener("change",market);
    $("clubBrand").addEventListener("change",clubTotals);
    $("clubForm").addEventListener("submit",async e=>{
        e.preventDefault();if(pending)return;pending=true;$("clubSave").disabled=true;
        try{const data=await api("club",{teamId:$("clubBrand").value,revision:club.revision,players:entries()});renderClub(data);$("clubReceipt").textContent="Elenco salvo · "+ArcadiaWallet.format(data.charged)+" investidos";}
        catch(error){$("clubReceipt").textContent=error.message;}
        finally{pending=false;$("clubSave").disabled=false;}
    });
    window.addEventListener("pagehide",()=>{destroyed=true;clearTimeout(pollTimer);visual?.destroy();});
    (async()=>{
        $("soloMode").classList.toggle("active",!clubMode);$("duelMode").classList.toggle("active",clubMode);
        $("soloView").hidden=clubMode;$("clubView").hidden=!clubMode;
        await ArcadiaAPI.ready;
        catalog=await api("catalog");
        if(clubMode){
            if(!ArcadiaAPI.isLoggedIn()){status("Entre na sua conta para montar seu elenco.");$("clubForm").hidden=true;return;}
            options($("clubBrand"),catalog.teams);visual=ArcadiaFootballVisual.create($("clubStage"));renderClub(await api("club"));
        }else{
            options($("homeTeam"),catalog.teams);options($("awayTeam"),catalog.teams);$("awayTeam").selectedIndex=1;
            visual=ArcadiaFootballVisual.create($("footballStage"));await market();
            if(ArcadiaAPI.isLoggedIn())await poll();
        }
        await ArcadiaWallet.refresh();
    })().catch(error=>status(error.message));
})();
