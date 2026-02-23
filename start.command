#!/bin/bash

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# 设置颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  Jimeng API 启动脚本${NC}"
echo -e "${GREEN}================================${NC}"
echo ""

# 函数：安装 Homebrew
install_homebrew() {
    echo -e "${YELLOW}正在安装 Homebrew...${NC}"
    echo -e "${BLUE}这可能需要几分钟时间，请耐心等待...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Homebrew 安装成功${NC}"
        # 添加 Homebrew 到 PATH
        if [[ $(uname -m) == 'arm64' ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        else
            eval "$(/usr/local/bin/brew shellenv)"
        fi
        return 0
    else
        echo -e "${RED}✗ Homebrew 安装失败${NC}"
        return 1
    fi
}

# 函数：安装 Node.js
install_nodejs() {
    echo -e "${YELLOW}正在安装 Node.js...${NC}"
    echo -e "${BLUE}这可能需要几分钟时间，请耐心等待...${NC}"
    brew install node

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Node.js 安装成功${NC}"
        return 0
    else
        echo -e "${RED}✗ Node.js 安装失败${NC}"
        return 1
    fi
}

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}⚠ 未检测到 Node.js，开始自动安装...${NC}"
    echo ""

    # 检查是否安装了 Homebrew
    if ! command -v brew &> /dev/null; then
        echo -e "${YELLOW}⚠ 未检测到 Homebrew（Mac 包管理器）${NC}"
        echo -e "${BLUE}正在自动安装 Homebrew...${NC}"
        echo ""

        # 安装 Homebrew
        install_homebrew
        if [ $? -ne 0 ]; then
            echo -e "${RED}✗ Homebrew 安装失败${NC}"
            echo -e "${YELLOW}请手动访问 https://brew.sh 安装${NC}"
            echo "5 秒后自动退出..."
            sleep 5
            exit 1
        fi

        echo ""
    else
        echo -e "${GREEN}✓${NC} 检测到 Homebrew"
        echo ""
    fi

    # 安装 Node.js
    echo -e "${BLUE}正在自动安装 Node.js...${NC}"
    install_nodejs
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Node.js 安装失败${NC}"
        echo -e "${YELLOW}请手动运行: brew install node${NC}"
        echo "5 秒后自动退出..."
        sleep 5
        exit 1
    fi

    echo ""
fi

echo -e "${GREEN}✓${NC} Node.js 版本: $(node --version)"
echo ""

# 检查依赖是否已安装
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}未找到依赖，正在安装...${NC}"
    npm install
    if [ $? -ne 0 ]; then
        echo -e "${RED}依赖安装失败${NC}"
        echo "按任意键退出..."
        read -n 1
        exit 1
    fi
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
    echo ""
fi

# 检查是否需要构建
if [ ! -d "dist" ]; then
    echo -e "${YELLOW}未找到构建文件，正在构建...${NC}"
    npm run build
    if [ $? -ne 0 ]; then
        echo -e "${RED}构建失败${NC}"
        echo "按任意键退出..."
        read -n 1
        exit 1
    fi
    echo -e "${GREEN}✓ 构建完成${NC}"
    echo ""
fi

# 启动服务
echo -e "${GREEN}正在启动 Jimeng API 服务...${NC}"
echo -e "${YELLOW}服务地址: http://localhost:5100${NC}"
echo -e "${YELLOW}按 Ctrl+C 停止服务${NC}"
echo ""
echo -e "${GREEN}================================${NC}"
echo ""

# 启动服务
npm start

# 如果服务异常退出
echo ""
echo -e "${RED}服务已停止${NC}"
echo "按任意键退出..."
read -n 1
