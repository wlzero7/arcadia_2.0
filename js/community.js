(() => {
    const $ = (id) => document.getElementById(id);
    const esc = ArcadiaAPI.escapeHtml;
    const icons = () => window.lucide?.createIcons();
    const api = (path, method = "GET", body) => ArcadiaAPI.request("/api/community" + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    let permissions = { registered: false, canFeedback: false, moderator: false, level: 0 };
    let channel = "discussion", cursor = null, current = null, replyCursor = null, pendingModeration = null;
    let loading = false, revision = 0, threadRevision = 0;
    const loginUrl = () => "index.html?login=1&return=" + encodeURIComponent("/comunidade.html?category=" + channel);
    const date = (value) => new Date(value.replace(" ", "T") + "Z").toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    function identity(value) {
        return `<div class="player-identity"><span class="player-avatar" data-avatar="${esc(value.avatar || "")}" data-name="${esc(value.username)}"></span><div><strong>${esc(value.display_name || value.username)}</strong><div class="thread-meta">Lv ${Number(value.level)} ${value.created_at ? "<span>"+date(value.created_at)+"</span>" : ""}</div></div></div>`;
    }
    function avatars(root) {
        root.querySelectorAll("[data-avatar]").forEach((element) => ArcadiaAvatar.render(element, element.dataset.avatar, element.dataset.name));
        icons();
    }
    function message(copy, login = false) {
        const element = $("communityMessage");
        element.replaceChildren(document.createTextNode(copy));
        if (login) {
            element.append(document.createElement("br"));
            const link = document.createElement("a"); link.href = loginUrl(); link.textContent = "Entrar na minha conta"; element.append(link);
        }
        element.hidden = false;
    }
    function updateAccess() {
        const user = ArcadiaAPI.getUser();
        $("communityProfile").replaceChildren();
        if (user && permissions.registered) {
            $("communityProfile").innerHTML = identity({ ...user, level: permissions.level }) + "<p>Jogador do Arcadia</p>";
            avatars($("communityProfile"));
        } else {
            const link = document.createElement("a"); link.className = "btn btn-outline"; link.href = loginUrl(); link.textContent = "Entrar"; $("communityProfile").append(link);
        }
        $("feedbackTab").querySelector(".feedback-lock")?.classList.toggle("hidden", permissions.canFeedback);
        $("newThread").disabled = channel === "feedback" && !permissions.canFeedback;
    }
    async function selectChannel(value) {
        revision++;
        channel = value; cursor = null;
        $("threadList").replaceChildren(); $("communityMessage").hidden = true; $("loadMore").hidden = true;
        $("channelTitle").textContent = value === "feedback" ? "Feedbacks" : "Discussoes";
        document.querySelectorAll("[data-category]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.category === channel)));
        history.replaceState(null, "", "?category=" + channel);
        updateAccess();
        if (channel === "feedback" && !permissions.canFeedback) {
            message(permissions.registered ? "Feedbacks bloqueados. Seu nivel: " + permissions.level + ". Nivel necessario: 5." : "Entre em uma conta de nivel 5 ou superior para acessar os feedbacks.", !permissions.registered);
            return;
        }
        await loadThreads();
    }
    async function loadThreads(append = false) {
        if (loading) return;
        loading = true;
        const version = revision;
        $("loadMore").disabled = true;
        const query = new URLSearchParams({ category: channel, search: $("threadSearch").value.trim() });
        if (append && cursor) query.set("before", cursor);
        try {
            const data = await api("/threads?" + query);
            if (version !== revision) return;
            if (!append) $("threadList").replaceChildren();
            for (const item of data.items) {
                const row = document.createElement("article"); row.className = "thread-row";
                row.innerHTML = `<span class="player-avatar" data-avatar="${esc(item.avatar || "")}" data-name="${esc(item.username)}"></span><div class="thread-copy"><button class="thread-title" data-thread="${item.id}">${esc(item.title)}</button><div class="thread-meta"><span>${esc(item.display_name || item.username)}</span><span>Lv ${item.level}</span><span>${date(item.created_at)}</span>${item.state === "closed" ? "<span>Encerrado</span>" : ""}</div></div><div class="thread-counts"><span title="Respostas"><i data-lucide="message-circle"></i> ${item.replies}</span><span title="Curtidas"><i data-lucide="heart"></i> ${item.likes}</span></div>`;
                $("threadList").append(row);
            }
            cursor = data.nextCursor;
            $("loadMore").hidden = !cursor;
            if (!$("threadList").children.length) {
                const empty = document.createElement("p"); empty.className = "community-empty"; empty.textContent = "Nenhum topico encontrado."; $("threadList").append(empty);
            }
            avatars($("threadList"));
        } catch (error) { if (version === revision) message(error.message, error.status === 401); }
        finally {
            loading = false; $("loadMore").disabled = false;
            if (version !== revision && (channel !== "feedback" || permissions.canFeedback)) loadThreads();
        }
    }
    async function openThread(id, appendReplies = false) {
        const version = ++threadRevision;
        $("replyMessage").textContent = "";
        try {
            const query = new URLSearchParams();
            if (appendReplies && replyCursor) query.set("before", replyCursor);
            const data = await api("/threads/" + id + (query.size ? "?" + query : ""));
            if (version !== threadRevision) return;
            current = data.thread;
            $("threadCategory").textContent = current.category === "feedback" ? "FEEDBACK" : "DISCUSSAO";
            $("threadContent").innerHTML = `<h1>${esc(current.title)}</h1>${identity(current)}<div class="community-body">${esc(current.body)}</div><div class="thread-actions"><button class="btn btn-outline" data-like aria-pressed="${!!current.liked}" ${permissions.registered ? "" : "disabled"}><i data-lucide="heart"></i> ${current.likes}</button>${current.canManage ? `<button class="icon-button" data-moderate="${current.state === "closed" ? "reopen" : "close"}" title="${current.state === "closed" ? "Reabrir" : "Encerrar"}" aria-label="${current.state === "closed" ? "Reabrir" : "Encerrar"}"><i data-lucide="${current.state === "closed" ? "unlock" : "lock"}"></i></button><button class="icon-button" data-moderate="remove" title="Remover topico" aria-label="Remover topico"><i data-lucide="trash-2"></i></button>` : ""}<span class="muted">${current.state === "closed" ? "Topico encerrado" : ""}</span></div>`;
            if (!appendReplies) $("replyList").replaceChildren();
            const fragment = document.createDocumentFragment();
            for (const reply of data.replies.slice().reverse()) {
                const row = document.createElement("article"); row.className = "reply-row";
                const manage = permissions.moderator || reply.user_id === ArcadiaAPI.getUser()?.id;
                row.innerHTML = `<div class="reply-heading">${identity(reply)}${manage ? `<button class="icon-button" data-moderate="remove" data-reply="${reply.id}" title="Remover resposta" aria-label="Remover resposta"><i data-lucide="trash-2"></i></button>` : ""}</div><div class="community-body">${esc(reply.body)}</div>`;
                fragment.append(row);
            }
            $("replyList").prepend(fragment); replyCursor = data.nextCursor; $("olderReplies").hidden = !replyCursor;
            $("replyForm").hidden = !permissions.registered || current.state !== "open";
            if (!permissions.registered) $("replyMessage").textContent = "Entre na sua conta para responder.";
            avatars($("threadDialog"));
            if (!$("threadDialog").open) $("threadDialog").showModal();
        } catch (error) { message(error.message, error.status === 401); }
    }
    document.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => selectChannel(button.dataset.category)));
    document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).close()));
    $("threadDialog").addEventListener("close", () => { current = null; threadRevision++; });
    $("threadList").addEventListener("click", (event) => { const button = event.target.closest("[data-thread]"); if (button) openThread(Number(button.dataset.thread)); });
    $("loadMore").addEventListener("click", () => loadThreads(true));
    $("olderReplies").addEventListener("click", () => current && openThread(current.id, true));
    $("searchForm").addEventListener("submit", (event) => { event.preventDefault(); revision++; cursor = null; $("communityMessage").hidden = true; if (channel !== "feedback" || permissions.canFeedback) loadThreads(); });
    $("newThread").addEventListener("click", () => {
        if (!permissions.registered) return message("Entre na sua conta para publicar.", true);
        $("composeForm").reset(); $("composeMessage").textContent = ""; $("composeDialog").showModal();
    });
    $("composeForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = event.submitter; button.disabled = true;
        try {
            const data = await api("/threads", "POST", { category: channel, title: $("threadTitle").value, body: $("threadBody").value });
            $("composeDialog").close(); revision++; cursor = null; await loadThreads(); await openThread(data.id);
        } catch (error) { $("composeMessage").textContent = error.message; }
        finally { button.disabled = false; }
    });
    $("replyForm").addEventListener("submit", async (event) => {
        event.preventDefault(); if (!current) return;
        const button = event.submitter; button.disabled = true;
        try { const id = current.id; await api("/threads/" + id + "/replies", "POST", { body: $("replyBody").value }); $("replyForm").reset(); await openThread(id); await loadThreads(); }
        catch (error) { $("replyMessage").textContent = error.message; }
        finally { button.disabled = false; }
    });
    $("threadDialog").addEventListener("click", async (event) => {
        if (!current) return;
        const like = event.target.closest("[data-like]");
        if (like) {
            like.disabled = true;
            try { const id = current.id; await api("/threads/" + id + "/like", "POST", { liked: !current.liked }); await openThread(id); await loadThreads(); }
            catch (error) { $("replyMessage").textContent = error.message; like.disabled = false; }
        }
        const action = event.target.closest("[data-moderate]");
        if (action) {
            pendingModeration = { id: current.id, action: action.dataset.moderate, replyId: action.dataset.reply };
            $("moderationTitle").textContent = action.title; $("moderationForm").reset(); $("moderationMessage").textContent = ""; $("moderationDialog").showModal();
        }
    });
    $("moderationForm").addEventListener("submit", async (event) => {
        event.preventDefault(); if (!pendingModeration) return;
        const button = event.submitter; button.disabled = true;
        try {
            const change = pendingModeration;
            await api("/threads/" + change.id + (change.replyId ? "/replies/" + change.replyId : ""), "PATCH", { action: change.action, reason: $("moderationReason").value });
            $("moderationDialog").close();
            if (change.action === "remove" && !change.replyId) $("threadDialog").close(); else await openThread(change.id);
            await loadThreads();
        } catch (error) { $("moderationMessage").textContent = error.message; }
        finally { button.disabled = false; }
    });
    (async () => {
        await ArcadiaAPI.ready;
        if (ArcadiaAPI.isLoggedIn()) {
            try { permissions = await api("/access"); }
            catch (error) { message(error.message); }
        }
        const requested = new URLSearchParams(location.search).get("category");
        await selectChannel(requested === "feedback" ? "feedback" : "discussion");
        icons();
    })();
})();
