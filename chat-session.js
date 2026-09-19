// Keep successful history independent of provider chat instances.
export async function respondWithFallback(models, session, message) {
    let lastError;
    for (let offset = 0; offset < models.length; offset++) {
        const index = (session.modelIndex + offset) % models.length;
        try {
            const chat = models[index].startChat({ history: structuredClone(session.history) });
            const result = await chat.sendMessage(message);
            const reply = result.response.text();
            if (!reply.trim()) throw new Error('Empty model response');
            session.history = [...session.history,
                { role: 'user', parts: [{ text: message }] },
                { role: 'model', parts: [{ text: reply }] },
            ].slice(-20);
            session.modelIndex = index;
            return { reply, modelIndex: index };
        } catch (error) { lastError = error; }
    }
    throw lastError || new Error('No models configured');
}
