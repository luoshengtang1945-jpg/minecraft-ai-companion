const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const inputs = [path.join(root, 'bot.js'), path.join(root, 'src'), path.join(root, 'test'), path.join(root, 'scripts'), path.join(root, 'benchmark')]
const files = []

function collect(filePath) {
  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(filePath)) collect(path.join(filePath, entry))
  } else if (filePath.endsWith('.js')) {
    files.push(filePath)
  }
}

for (const input of inputs) collect(input)

for (const file of new Set(files)) {
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file })
}

console.log(`Syntax OK: ${new Set(files).size} JavaScript files`)
