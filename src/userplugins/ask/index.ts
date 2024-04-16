import { RequiredMessageOption, findOption } from "@api/Commands";
import definePlugin from "../../utils/types";

async function ask(query){
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts/2565c47901f849101e8f9236a45456ec/ai/run/@cf/meta/llama-2-7b-chat-int8', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer 22yzWybb-INtwAsbNaROKlKi7pq_7Uzy4m5WAzCw',
        },
        body: JSON.stringify({
            prompt: `${query}. Answer briefly and factually.`,
            stream: false,
        }),
    })
    console.log(response)
    return 'egg';
}

export default definePlugin({
    name: "lookup",
    authors: [{
        name: "KaminoUwU",
        id: BigInt(660882539413635082),
    }],
    description: "Add a command to ask Cloudflare AI a question",
    dependencies: ["CommandsAPI"],
    commands: [{
        name: "lookup",
        description: "Ask Cloudflare AI a question",
        options: [RequiredMessageOption],
        execute: async (opts) => {
            const query = findOption(opts, "message", "Who are you?");
            return {
                content: await ask(query),
            };
        },
    }]
});