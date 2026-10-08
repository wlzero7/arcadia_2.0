window.ArcadiaFootballControls = {
    async mount(area, onPlay, limits = {}) {
        const ticket=area.dataset.footballMount;
        const data = await ArcadiaAPI.request("/api/games/football/catalog");
        if (!area.isConnected || area.dataset.footballMount !== ticket) return;
        area.dataset.footballMount = "ready";
        area.replaceChildren();
        area.classList.add("football-bets");
        const controls = {};
        for (const [id, title] of [["home","Casa"],["away","Visitante"]]) {
            const label=document.createElement("label");label.textContent=title;
            const select=document.createElement("select");select.id="mpFootball"+id;select.dataset.footballChoice=id;
            for(const team of data.teams)select.add(new Option(team.name,team.id));
            label.append(select);area.append(label);controls[id]=select;
        }
        controls.away.selectedIndex=1;
        const market=document.createElement("fieldset");market.className="football-market";area.append(market);
        const row=document.createElement("div");row.className="football-wager";
        const wager=document.createElement("input");wager.type="number";wager.id="mpBet";wager.min=limits.minBet||10;wager.max=limits.maxBet||1000;wager.value=100;wager.setAttribute("aria-label","Aposta no pote");
        const play=document.createElement("button");play.id="mpPlay";play.className="btn btn-primary";play.textContent="Iniciar partida";play.type="button";
        row.append(wager);area.append(row,play);
        const result=document.createElement("div");result.id="mpResult";result.className="football-receipt";area.append(result);
        let generation=0, activeMatch=null;
        function paint(prices,picked="home") {
            market.replaceChildren();const legend=document.createElement("legend");legend.textContent="Resultado final";market.append(legend);
            for(const [key,label] of [["home","Casa"],["draw","Empate"],["away","Visitante"]]){
                const item=document.createElement("label");item.className="football-odd";
                const input=document.createElement("input");input.type="radio";input.name="mpFootballPick";input.value=key;input.checked=key===picked;input.dataset.footballChoice="picked";
                const name=document.createElement("span");name.textContent=label;const odd=document.createElement("strong");odd.textContent=prices.odds[key].toFixed(2)+"x";
                item.append(input,name,odd);market.append(item);
            }
        }
        area.footballSync=(match)=>{
            if(!match||match.id===activeMatch)return;
            activeMatch=match.id;generation++;
            controls.home.value=match.home.id;controls.away.value=match.away.id;wager.value=match.wager;
            paint(match,match.picked);area.dataset.marketPending="false";
        };
        async function update() {
            const current=++generation;play.disabled=true;area.dataset.marketPending="true";
            try{
                const prices=await ArcadiaAPI.request("/api/games/football/market?home="+controls.home.value+"&away="+controls.away.value);
                if(current!==generation||!area.isConnected)return;
                paint(prices);area.dataset.marketPending="false";play.disabled=false;
                area.dispatchEvent(new CustomEvent("football:market", { detail: { home:data.teams.find(t=>t.id===controls.home.value), away:data.teams.find(t=>t.id===controls.away.value) } }));
            }catch(error){if(current===generation)result.textContent=error.message;}
        }
        controls.home.addEventListener("change",update);controls.away.addEventListener("change",update);
        play.addEventListener("click",()=>onPlay({home:controls.home.value,away:controls.away.value,picked:market.querySelector("input:checked")?.value},Number(wager.value)));
        await update();
        area.dispatchEvent(new Event("football:ready"));
    }
};
