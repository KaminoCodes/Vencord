import definePlugin from "../../utils/types";

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function fetchReddit() {
    const subs = [
        "furry_irl",
        "furrymemes",
        "wholesomefurrymemes",
        "sfwfurrymemes",
        "beastars_memes"
    ]
    const sub = subs[Math.floor(Math.random()*subs.length)];
    const res = await fetch(`https://www.reddit.com/r/${sub}/top.json?limit=100&t=all`);
    const resp = await res.json();
    try {
        const { children } = resp.data;
        let r = rand(0, children.length-1);
        return children[r].data.url.replace(/&amp;/g, "&");
    } catch (err) {
        console.error(resp);
        console.error(err);
    }
    return "";
}

export default definePlugin({
    name: "furrymemes",
    authors: [{
        name: "KaminoUwU",
        id: BigInt(660882539413635082),
    }],
    description: "Add a command to send cute anime boys in the chat",
    dependencies: ["CommandsAPI"],
    commands: [{
        name: "furrymeme",
        description: "Send a furry meme",
        async execute() {
            return {
                content: await fetchReddit(),
            };
        },
    }]
});