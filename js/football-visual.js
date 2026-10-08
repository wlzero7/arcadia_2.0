window.ArcadiaFootballVisual = (() => {
    let module;
    function create(stage) {
        let instance, disposed=false, pending;
        stage.classList.add("football-stadium");
        stage.textContent="Preparando estadio...";
        const ready=(module ||= import("./football-stadium.js")).then(({create})=>{
            if(disposed)return;
            instance=create(stage);
            if(pending)instance[pending.method](...pending.args);
        }).catch(()=>{
            if(!disposed)stage.textContent="Nao foi possivel carregar o estadio. Recarregue a pagina.";
        });
        const send=(method,...args)=>{if(disposed)return;if(instance)instance[method](...args);else pending={method,args};};
        return {live:(...args)=>send("live",...args),preview:(...args)=>send("preview",...args),
            round:async(result)=>{send("round",result);await ready;},
            destroy:()=>{disposed=true;instance?.destroy();stage.classList.remove("football-stadium");if(!instance)stage.replaceChildren();}};
    }
    return {create};
})();
