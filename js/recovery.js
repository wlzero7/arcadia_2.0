(() => {
    const form = document.getElementById("recoveryForm"), message = document.getElementById("recoveryMessage"), button = document.getElementById("recoverySubmit");
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    history.replaceState(null, "", location.pathname);
    if (token) {
        document.getElementById("recoveryTitle").textContent = "Definir nova senha";
        document.getElementById("identifierField").hidden = true; form.elements.identifier.required = false;
        document.getElementById("newPasswordFields").hidden = false;
        form.elements.password.required = form.elements.confirmation.required = true; button.textContent = "Alterar senha";
    }
    form.addEventListener("submit", async (event) => {
        event.preventDefault(); if (button.disabled) return;
        message.textContent = ""; message.dataset.error = "false";
        if (token && form.elements.password.value !== form.elements.confirmation.value) { message.textContent = "As senhas nao conferem."; message.dataset.error = "true"; return; }
        button.disabled = true;
        try {
            const response = await fetch("/api/auth/" + (token ? "reset-password" : "forgot-password"), { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify(token ? { token, password: form.elements.password.value } : { identifier: form.elements.identifier.value }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.message || "Servico indisponivel.");
            message.textContent = data.message; form.reset();
            if (token) { form.querySelectorAll("input").forEach((input) => input.disabled = true); button.hidden = true; }
        } catch (error) { message.textContent = error.message; message.dataset.error = "true"; }
        finally { button.disabled = false; }
    });
})();
