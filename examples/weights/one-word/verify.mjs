// Scores one answer: 1 when it is exactly the expected word, 0 otherwise.
// atoll passes {"response", "expected", ...} on stdin and reads the number we print.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { response, expected } = JSON.parse(input);
console.log(String(response).trim() === String(expected).trim() ? 1 : 0);
