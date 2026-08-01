/**
 * 测活题库 - 包含数学、逻辑、常识等真实问题
 * 用于模型可用性探测，避免简单问题无法验证实际推理能力
 */

export type ProbeQuestion = {
  question: string;
  expectedKeywords?: string[]; // 用于简单验证回答是否合理
  category: 'math' | 'logic' | 'knowledge' | 'reasoning';
};

export const PROBE_QUESTIONS: ProbeQuestion[] = [
  // 数学题
  {
    question: '一个水池有甲乙两个进水管。单开甲管 6 小时可以注满水池，单开乙管 8 小时可以注满水池。如果两管同时打开，多少小时可以注满水池？请给出详细的解题过程。',
    expectedKeywords: ['24/7', '3.43', '3小时25分', '二十四分之七'],
    category: 'math',
  },
  {
    question: '计算：如果 log₂(x) = 5，log₂(y) = 3，那么 log₂(xy) 等于多少？请解释对数运算的基本原理。',
    expectedKeywords: ['8', 'log₂(x) + log₂(y)', '5 + 3'],
    category: 'math',
  },
  {
    question: '一个等差数列的首项是 3，公差是 4，求第 20 项的值以及前 20 项的和。',
    expectedKeywords: ['79', '820', 'a₁ + (n-1)d', 'n/2 × (2a₁ + (n-1)d)'],
    category: 'math',
  },
  {
    question: '求解方程组：2x + 3y = 12，4x - y = 5。请给出 x 和 y 的值。',
    expectedKeywords: ['x =', 'y =', '21/14', '3/2', '1.5'],
    category: 'math',
  },
  
  // 逻辑推理题
  {
    question: '甲、乙、丙三人中只有一人说了真话。甲说："乙在说谎"，乙说："丙在说谎"，丙说："甲和乙都在说谎"。请问谁说了真话？请详细分析推理过程。',
    expectedKeywords: ['乙', '真话', '假设', '矛盾'],
    category: 'logic',
  },
  {
    question: '有 5 个海盗抢得 100 枚金币。他们按抽签的顺序依次提方案：首先由 1 号提出分配方案，然后 5 人表决，超过半数同意方案才被通过，否则他将被扔入大海喂鲨鱼，依此类推。假设每个海盗都是绝顶聪明且理性，1 号应该提出什么方案才能使自己获得最多的金币？',
    expectedKeywords: ['97', '98', '分配', '投票', '策略'],
    category: 'logic',
  },
  {
    question: '一个房间里有 100 个人，每人手里有一个 1 到 100 之间的不同整数。每个人都可以看到其他 99 个人手里的数字，但看不到自己的。现在要求每个人猜自己手里的数字，至少要有 99 个人猜对。他们可以在游戏前商量策略，请问这个策略是什么？',
    expectedKeywords: ['奇偶', '校验和', '模运算', 'parity'],
    category: 'logic',
  },
  
  // 知识题
  {
    question: '请解释量子力学中的"薛定谔的猫"思想实验，包括其物理意义、对量子叠加态的诠释，以及这个实验在量子力学发展史上的重要性。',
    expectedKeywords: ['叠加态', '观测', '波函数', '哥本哈根诠释', '薛定谔'],
    category: 'knowledge',
  },
  {
    question: '详细解释 TCP 三次握手和四次挥手的过程，包括每个阶段的状态变化、序列号的作用，以及为什么需要三次握手而不是两次。',
    expectedKeywords: ['SYN', 'ACK', 'ESTABLISHED', 'FIN', 'TIME_WAIT'],
    category: 'knowledge',
  },
  {
    question: '请比较并解释 HTTP/1.1、HTTP/2 和 HTTP/3 的主要区别，包括它们在连接复用、头部压缩、传输协议等方面的改进。',
    expectedKeywords: ['多路复用', 'HPACK', 'QUIC', '头部压缩', '二进制分帧'],
    category: 'knowledge',
  },
  {
    question: '解释区块链的工作原理，包括哈希函数、Merkle 树、共识机制（如 PoW 和 PoS）的作用，以及为什么区块链具有不可篡改性。',
    expectedKeywords: ['哈希', 'Merkle', '共识', 'PoW', 'PoS', '不可篡改'],
    category: 'knowledge',
  },
  
  // 推理题
  {
    question: '有 12 个外观相同的球，其中 11 个重量相同，1 个重量不同（可能更重或更轻）。给你一个天平，最多称 3 次，如何找出那个重量不同的球，并确定它是更重还是更轻？请给出完整的称量策略。',
    expectedKeywords: ['分组', '天平', '比较', '排除', '策略'],
    category: 'reasoning',
  },
  {
    question: '一个农夫需要把狼、羊和白菜运过河。船每次只能载农夫和一样东西。如果农夫不在场，狼会吃羊，羊会吃白菜。请问农夫应该如何安排才能把所有东西安全运过河？请给出完整的步骤。',
    expectedKeywords: ['羊', '狼', '白菜', '往返', '步骤'],
    category: 'reasoning',
  },
  {
    question: '有 3 个开关分别控制 3 个灯泡，但你无法看到灯泡。你只能进入灯泡房间一次。如何确定每个开关控制哪个灯泡？请解释你的方法和背后的原理。',
    expectedKeywords: ['温度', '热量', '开关', '灯泡', '观察'],
    category: 'reasoning',
  },
];

/**
 * 随机选择一个测活问题
 */
export function getRandomProbeQuestion(): ProbeQuestion {
  const index = Math.floor(Math.random() * PROBE_QUESTIONS.length);
  return PROBE_QUESTIONS[index];
}

/**
 * 根据类别随机选择问题
 */
export function getRandomProbeQuestionByCategory(category: ProbeQuestion['category']): ProbeQuestion {
  const filtered = PROBE_QUESTIONS.filter(q => q.category === category);
  if (filtered.length === 0) {
    return getRandomProbeQuestion();
  }
  const index = Math.floor(Math.random() * filtered.length);
  return filtered[index];
}
