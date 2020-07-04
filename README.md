kousu
=====

todo description

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/kousu.svg)](https://npmjs.org/package/kousu)
[![Downloads/week](https://img.shields.io/npm/dw/kousu.svg)](https://npmjs.org/package/kousu)
[![License](https://img.shields.io/npm/l/kousu.svg)](https://github.com/wataash/kousu/blob/master/package.json)

<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g kousu
$ kousu COMMAND
running command...
$ kousu (-v|--version|version)
kousu/0.0.0 linux-x64 node-v14.1.0
$ kousu --help [COMMAND]
USAGE
  $ kousu COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`kousu hello [FILE]`](#kousu-hello-file)
* [`kousu help [COMMAND]`](#kousu-help-command)

## `kousu hello [FILE]`

describe the command here

```
USAGE
  $ kousu hello [FILE]

OPTIONS
  -f, --force
  -h, --help       show CLI help
  -n, --name=name  name to print

EXAMPLE
  $ kousu hello
  hello world from ./src/hello.ts!
```

_See code: [src/commands/hello.ts](https://github.com/wataash/kousu/blob/v0.0.0/src/commands/hello.ts)_

## `kousu help [COMMAND]`

display help for kousu

```
USAGE
  $ kousu help [COMMAND]

ARGUMENTS
  COMMAND  command to show help for

OPTIONS
  --all  see all commands in CLI
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v3.1.0/src/commands/help.ts)_
<!-- commandsstop -->
