// 示例 TypeScript 代码用于测试 LSP 调用层次查询
// 使用方法：
// 1. 将光标放在任意函数名上（如 add, multiply, useCalculator）
// 2. 按 Ctrl+Shift+P
// 3. 输入 "测试 LSP 调用层次查询"

class Calculator {
    
    





    nothing() {
        // 这个函数没有被调用，测试时应该没有调用者和被调用者
    }

    /**
     * 加法运算
     * 测试：将光标放在 "add" 上运行测试命令
     * 预期：应该找到 multiply 和 useCalculator 作为调用者
     */
    add(a: number, b: number): number {
        return a + b;
    }

    /**
     * 减法运算
     */
    subtract(a: number, b: number): number {
        return a - b;
    }

    /**
     * 乘法运算（通过调用 add 实现）
     * 测试：将光标放在 "multiply" 上运行测试命令
     * 预期：调用者 = useCalculator, 被调用者 = add
     */
    multiply(a: number, b: number): number {
        return this.add(a * b, 0);  // 调用 add
    }

    /**
     * 复合运算
     */
    complex(a: number, b: number, c: number): number {
        const temp1 = this.add(a, b);      // 调用 add
        const temp2 = this.multiply(b, c); // 调用 multiply
        return this.subtract(temp1, temp2); // 调用 subtract
    }
}
























/**
 * 使用计算器的函数
 * 测试：将光标放在 "useCalculator" 上运行测试命令
 * 预期：调用者 = main, 被调用者 = add, multiply
 */
function useCalculator() {
    const calc = new Calculator();
    const sum = calc.add(5, 3);           // 调用 add
    const product = calc.multiply(4, 2);  // 调用 multiply
    return sum + product;
}




/**
 * 另一个使用计算器的函数
 */




function advancedCalculation() {
    const calc = new Calculator();
    return calc.complex(10, 5, 2);  // 调用 complex
}

/**
 * 主函数（入口点）
 * 测试：将光标放在 "main" 上运行测试命令
 * 预期：调用者 = (无), 被调用者 = useCalculator, advancedCalculation
 */




function main() {
    const result1 = useCalculator();       // 调用 useCalculator
    const result2 = advancedCalculation(); // 调用 advancedCalculation
    console.log('结果:', result1, result2);
}

// 程序入口
main();
