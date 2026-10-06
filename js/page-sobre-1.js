// saldo no header + botão de som
        (async () => {
            if (ArcadiaAPI.isLoggedIn()) {
                await ArcadiaWallet.refresh();
                document.getElementById("walletBalance").textContent = ArcadiaWallet.format(ArcadiaWallet.getCached());
            }
        })();
