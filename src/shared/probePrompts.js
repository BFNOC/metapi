export const PROBE_PROMPTS = [
    '请用一句话解释什么是量子计算，要求非常清晰，而且让初学者也能立刻理解。',
    'JavaScript 的 Promise 和 async/await 有什么区别？请用最精炼的方式回答。',
    '帮我写一个简单的 Rust 示例，最好能体现所有权和生命周期的特点。',
    '什么是 RESTful API？顺便用三句话对比一下它和 GraphQL。',
    '计算 237 乘以 128 等于多少？',
    '请列举三种常见排序算法，并分别说明更适合什么场景。',
    'CSS 里的 flex 和 grid 有什么区别？什么时候更适合用它们？',
    '请用简洁的话解释 TCP 三次握手为什么必要，以及 UDP 为什么不用握手。',
    'Explain the difference between TCP and UDP in simple terms.',
    'Write a Python function to check whether a string is a palindrome.',
    'What are the SOLID principles in software engineering?',
];
export function pickRandomProbePrompt() {
    return PROBE_PROMPTS[Math.floor(Math.random() * PROBE_PROMPTS.length)] || PROBE_PROMPTS[0];
}
export function resolveProbePrompt(input) {
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed)
            return trimmed;
    }
    return pickRandomProbePrompt();
}
