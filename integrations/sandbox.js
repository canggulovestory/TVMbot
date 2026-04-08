// /root/claude-chatbot/integrations/sandbox.js
const { VM, VMScript } = require('vm2');

async function runCode(code, timeout = 5000) {
  try {
    const output = [];
    
    const vm = new VM({
      timeout,
      sandbox: {
        console: {
          log: (...args) => output.push(args.map(String).join(' ')),
          error: (...args) => output.push('[ERROR] ' + args.map(String).join(' ')),
          warn: (...args) => output.push('[WARN] ' + args.map(String).join(' ')),
        },
        Math,
        JSON,
        Date,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        Number,
        String,
        Boolean,
        Array,
        Object,
        RegExp
      }
    });
    
    // Run the code
    const result = vm.run(code);
    
    return {
      success: true,
      result: result !== undefined ? String(result) : undefined,
      output: output.join('\n'),
      logs: output
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      type: err.constructor.name
    };
  }
}

module.exports = { runCode };
