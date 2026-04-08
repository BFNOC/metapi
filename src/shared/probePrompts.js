export const PROBE_PROMPTS = [
    // 短事实题：答案唯一、输出极短
    '请给出法国首都的名称。只输出城市名，不要解释。',
    '请给出南美洲面积最大的国家的首都名称。只输出城市名，不要包含标点或解释。',
    'In what year did the Apollo 11 moon landing occur? Output ONLY the 4-digit year.',
    'Which actor played Iron Man in the 2008 Marvel movie? Output ONLY the first and last name.',
    'What is the Spanish word for "library"? Output ONLY the translated word in lowercase.',
    'Water boils at what temperature in Celsius at sea level? Output the number only.',
    '人类正常的体细胞通常包含多少对染色体？只输出两位数。',
    'HTTP 状态码中代表 "I\'m a teapot" 的是哪一个？请只回答这 3 位数字。',
    'Which default port number is used by PostgreSQL? Output only the 4-digit number.',

    // 短计算题：计算量很小，通常能快速回字
    '计算 237 乘以 128 等于多少？只输出数字，不要解释。',
    '计算 50 到 70 之间所有素数的和。请只输出最终数字结果。',
    'What is the 12th number in the Fibonacci sequence? Return ONLY the integer.',
    '如果今天是星期二，那么 100 天后是星期几？只输出“星期X”这三个字。',
    '一个挂钟敲 3 下需要 4 秒，请问它匀速敲 6 下需要几秒？只输出阿拉伯数字，不要加单位。',
    'Which is heavier: a kilogram of feathers or a kilogram of steel? Output ONLY "Neither" or one material name.',

    // 短翻译题：像普通问答，输出长度稳定
    '请将“早起的人效率更高”翻译成自然的英文句子。只输出译文，不要解释。',
    'Translate "Knowledge is power" into French. Output ONLY the translated sentence.',
    '请把“图书馆今天几点关门？”翻译成英文。只输出译文，不要加引号。',
    'Translate "Good habits take time to build" into Spanish. Output ONLY the translated sentence.'
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
