const POSITIONS = ["GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "ATT", "ATT", "ATT"];
const NAMES = [
    ["Luca","Moretti"],["Noah","Whitfield"],["Ren","Takahara"],["Mateo","Valcazar"],["Amir","Nouri"],["Felix","Lindholm"],["Kwame","Agyeman"],["Thiago","Figueira"],["Emil","Bergstrom"],["Jules","Delacroix"],["Ivan","Vukovic"],
    ["Hugo","Montreuil"],["Kenji","Moriyama"],["Elias","Hartmann"],["Omar","Haddad"],["Dario","Bellandi"],["Santiago","Villalba"],["Kofi","Mensah"],["Arjun","Deshmukh"],["Milan","Petrovic"],["Rafael","Siqueira"],["Finn","Ashworth"],
    ["Leo","Falkenberg"],["Yuto","Kawashima"],["Idris","Bensaid"],["Nicolas","Aravena"],["Enzo","Ferrante"],["Aiden","Kingsley"],["Minjun","Han"],["Caio","Tavares"],["Soren","Nygaard"],["Marcel","Beauchamp"],["Ade","Okonkwo"],
    ["Oliver","Redwood"],["Akira","Fujimori"],["Malik","Darwish"],["Tomas","Becerra"],["Lorenzo","Pellegrini"],["Henrik","Sundqvist"],["Chidi","Eze"],["Gabriel","Pacheco"],["Nikhil","Kulkarni"],["Remy","Lefevre"],["Stefan","Kovacevic"],
    ["Riku","Aizawa"],["Isaac","Fairbourne"],["Youssef","Elmasri"],["Alejandro","Salcedo"],["Matteo","Venturi"],["Anton","Lundgren"],["Jabari","Kamau"],["Diego","Barreto"],["Wei","Zhang"],["Bastien","Rochefort"],["Andrej","Dragovic"],
    ["Max","Westerlund"],["Daichi","Shimizu"],["Zain","Qureshi"],["Emilio","Cordoba"],["Alessio","Rossetti"],["Declan","Callahan"],["Tunde","Adebayo"],["Pedro","Vasconcelos"],["Seojun","Park"],["Lucien","Deschamps"],["Luka","Radovan"],
    ["Theo","Blackwell"],["Sota","Mizuno"],["Karim","Benali"],["Joaquin","Montalvo"],["Giulio","Marchetti"],["Viktor","Ekstrom"],["Amadou","Diop"],["Bruno","Cerqueira"],["Aditya","Patwardhan"],["Etienne","Lavigne"],["Nikola","Djuric"],
    ["Oscar","Briarwood"],["Haruto","Nishimura"],["Sami","Rahmani"],["Facundo","Ledesma"],["Tommaso","Galli"],["Magnus","Solberg"],["Moussa","Traore"],["Lucas","Azevedo"],["Jian","Liu"],["Florian","Mercier"],["Miroslav","Stojanovic"],
    ["Arthur","Hawthorne"],["Takumi","Kitamura"],["Rami","Farouk"],["Esteban","Carranza"],["Fabio","Ricciardi"],["Nils","Haugen"],["Sekou","Kone"],["Vitor","Nogueira"],["Jiho","Choi"],["Adrien","Fontaine"],["Boris","Markovic"],
    ["Dylan","Lockwood"],["Kaito","Hoshino"],["Bilal","Saidi"],["Rodrigo","Zambrano"],["Elia","Benedetti"],["Lars","Dahl"],["Cheikh","Sarr"],["Heitor","Meireles"],["Rohan","Iyer"],["Cedric","Dumont"],["Ognjen","Savic"],
    ["Ethan","Westbrook"],["Naoki","Uehara"],["Tariq","Mansour"],["Ignacio","Paredes"],["Silvio","Caruso"],["Axel","Strand"],["Issa","Coulibaly"],["Joao","Peixoto"],["Yichen","Wang"],["Quentin","Bellerose"],["Vladan","Milosevic"],
    ["Callum","Everhart"],["Hiro","Ogawa"],["Faris","Khalil"],["Leonardo","Figueroa"],["Pietro","Donati"],["Erik","Vestergaard"],["Demba","Fall"],["Andre","Cavalcante"],["Taeyang","Yoon"],["Mathis","Garnier"],["Zoran","Jovanovic"],
    ["Rowan","Sterling"],["Itsuki","Endo"],["Nabil","Aziz"],["Martin","Velasco"],["Davide","Greco"],["Ivar","Skog"],["Sadio","Cisse"],["Felipe","Andrade"],["Aarav","Bhat"],["Loic","Chevalier"],["Dusan","Ristic"],
    ["Jasper","Northcott"],["Shun","Kuroda"],["Adil","Hakimi"],["Andres","Escalante"],["Niccolo","Vitali"],["Espen","Fjeld"],["Bakary","Diallo"],["Samuel","Medeiros"],["Jun","Seo"],["Damien","Valcourt"],["Vanja","Zivkovic"],
];
const DEFINITIONS = [
    ["aurora","Aurora FC","AUR","#ed4354","#ffffff",84],
    ["porto","Porto Azul","POR","#237bec","#ffffff",79],
    ["estrela","Estrela Verde","EST","#13a873","#ffffff",75],
    ["solar","Atletico Solar","SOL","#e9c535","#23262b",72],
    ["norte","Norte United","NOR","#cbd5dc","#344056",70],
    ["metro","Metro SC","MET","#cf3387","#202329",68],
    ["vale","Vale Real","VAL","#8246b6","#e9c535",66],
    ["costa","Costa Rubra","COS","#b72743","#eeeeee",64],
    ["ferrovia","Ferrovia FC","FER","#7b8d9a","#a3263d",62],
    ["serra","Serra Brava","SER","#ed743b","#202329",60],
    ["olimpo","Olimpo AC","OLI","#31b7cb","#26353f",58],
    ["horizonte","Horizonte FC","HOR","#49a986","#ebf5f3",55],
    ["vila","Vila Nova","VIL","#ec8cbb","#224b4b",50],
    ["bairro","Bairro SC","BAI","#3862b9","#eeeeee",45],
];
const TEAMS = DEFINITIONS.map(([id,name,short,color,secondary,rating], teamIndex) => ({
    id,name,short,color,secondary,
    players: POSITIONS.map((position, slot) => {
        const index = teamIndex * 11 + slot;
        const [firstName, lastName] = NAMES[index];
        return { id: "player-" + (index + 1), firstName, lastName, name: firstName + " " + lastName,
            shirtName: lastName.toUpperCase(), number: slot + 1,
            position, rating: rating + (index * 13 % 9) - 4 };
    }),
}));
for (const team of TEAMS) team.strength = Number((team.players.reduce((sum, player) => sum + player.rating, 0) / 11).toFixed(2));
const PLAYERS = TEAMS.flatMap((team) => team.players.map((player) => ({ ...player, teamId: team.id })));
const BY_TEAM = new Map(TEAMS.map((team) => [team.id, team]));
const BY_PLAYER = new Map(PLAYERS.map((player) => [player.id, player]));
function team(id) {
    const value = BY_TEAM.get(id);
    if (!value) throw new Error("Escolha um time valido.");
    return structuredClone(value);
}
module.exports = { TEAMS, PLAYERS, POSITIONS, BY_PLAYER, team };
