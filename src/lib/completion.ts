/**
 * Shell completion scripts and generators for ToolNet CLI.
 *
 * Supported shells: bash, zsh, fish.
 *
 * Manual installation:
 *   toolnet completion bash > ~/.local/share/bash-completion/completions/toolnet
 *   toolnet completion zsh  > ~/.zfunc/_toolnet   (add 'fpath+=~/.zfunc; autoload -Uz compinit && compinit' in ~/.zshrc)
 *   toolnet completion fish > ~/.config/fish/completions/toolnet.fish
 */

const SUBCOMMANDS =
  "config provider session resume skills tools queue completion update version usage budget doctor plugin pr issue audit telemetry";

const TOP_FLAGS =
  "--help -h --version -v --resume -r --session -s --model -m --prompt -p --simple --bypass -b --json --no-splash --verbose --format";

const bashCompletion = `# bash completion for toolnet
_toolnet_completions() {
  local cur prev words cword
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local subcmds="${SUBCOMMANDS}"
  local top_flags="${TOP_FLAGS}"

  # Subcommand specific completion
  if (( COMP_CWORD >= 2 )); then
    local subcmd="\${COMP_WORDS[1]}"
    case "\${subcmd}" in
      config)
        COMPREPLY=( $(compgen -W "init show path get set --help" -- "\${cur}") )
        return 0
        ;;
      provider|providers)
        COMPREPLY=( $(compgen -W "toolnet openai anthropic google groq openrouter deepseek list set --help" -- "\${cur}") )
        return 0
        ;;
      session|sessions)
        COMPREPLY=( $(compgen -W "current list resume delete --help" -- "\${cur}") )
        return 0
        ;;
      resume)
        COMPREPLY=( $(compgen -W "--help" -- "\${cur}") )
        return 0
        ;;
      skills)
        COMPREPLY=( $(compgen -W "list view install remove --help" -- "\${cur}") )
        return 0
        ;;
      tools)
        COMPREPLY=( $(compgen -W "list inspect --help" -- "\${cur}") )
        return 0
        ;;
      queue)
        COMPREPLY=( $(compgen -W "show add clear --help" -- "\${cur}") )
        return 0
        ;;
      completion)
        COMPREPLY=( $(compgen -W "bash zsh fish install --help" -- "\${cur}") )
        return 0
        ;;
      update)
        COMPREPLY=( $(compgen -W "--check --yes -y --force -f --help" -- "\${cur}") )
        return 0
        ;;
      version)
        COMPREPLY=( $(compgen -W "--json --help" -- "\${cur}") )
        return 0
        ;;
      usage)
        COMPREPLY=( $(compgen -W "--json --session --today --help" -- "\${cur}") )
        return 0
        ;;
      budget)
        COMPREPLY=( $(compgen -W "show set clear --enforce --help" -- "\${cur}") )
        return 0
        ;;
      doctor)
        COMPREPLY=( $(compgen -W "--json --help" -- "\${cur}") )
        return 0
        ;;
      plugin)
        COMPREPLY=( $(compgen -W "list install remove info --json --help" -- "\${cur}") )
        return 0
        ;;
      pr)
        COMPREPLY=( $(compgen -W "review --json --model --help" -- "\${cur}") )
        return 0
        ;;
      issue)
        COMPREPLY=( $(compgen -W "--json --model --help" -- "\${cur}") )
        return 0
        ;;
      audit)
        COMPREPLY=( $(compgen -W "show clear --json --help" -- "\${cur}") )
        return 0
        ;;
      telemetry)
        COMPREPLY=( $(compgen -W "status enable disable --help" -- "\${cur}") )
        return 0
        ;;
    esac
  fi

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${top_flags}" -- "\${cur}") )
  else
    COMPREPLY=( $(compgen -W "\${subcmds}" -- "\${cur}") )
  fi
}

complete -F _toolnet_completions toolnet
`;

const zshCompletion = `#compdef toolnet

_toolnet() {
  local -a commands subcommands

  commands=(
    'config:Show or modify configuration'
    'provider:Manage and switch AI providers'
    'session:Manage and resume sessions'
    'resume:Resume last active session or by ID'
    'skills:View and manage agent skills'
    'tools:Inspect registered local and MCP tools'
    'queue:Inspect and manage task queue'
    'completion:Generate shell completion scripts'
    'update:Check for and apply updates'
    'version:Show version information'
    'usage:Show token usage for current session'
    'budget:Manage spending budget'
    'doctor:Run diagnostic checks'
    'plugin:Manage plugins and extensions'
    'pr:Review pull requests'
    'issue:Analyze and debug repository issues'
    'audit:View security audit logs'
    'telemetry:Configure diagnostic telemetry'
  )

  subcommands=()
  if (( CURRENT > 1 )); then
    case \${words[2]} in
      config)
        subcommands=('init:Run the first-run setup wizard' 'show:Display current config' 'path:Print config file path' 'get:Get a config value' 'set:Set a config value')
        ;;
      provider|providers)
        subcommands=('toolnet:ToolNet Native Provider' 'openai:OpenAI Provider' 'anthropic:Anthropic Claude' 'google:Google Gemini' 'groq:Groq' 'openrouter:OpenRouter' 'deepseek:DeepSeek')
        ;;
      session|sessions)
        subcommands=('current:Show current session info' 'list:List saved sessions' 'resume:Resume session' 'delete:Delete session')
        ;;
      skills)
        subcommands=('list:List active skills' 'view:View skill details')
        ;;
      tools)
        subcommands=('list:List available tools' 'inspect:Inspect tool definitions')
        ;;
      queue)
        subcommands=('show:Display queued tasks' 'add:Enqueue new task' 'clear:Clear queue')
        ;;
      completion)
        subcommands=('bash:Bash completion script' 'zsh:Zsh completion script' 'fish:Fish completion script' 'install:Print installation instructions')
        ;;
      update)
        _arguments \
          '--check[Only check for updates, do not apply]' \
          '--yes[Skip confirmation prompts]' \
          '-y[Skip confirmation prompts]' \
          '--force[Force update even if same version]' \
          '-f[Force update even if same version]' \
          '--help[Show update help]'
        return
        ;;
      version)
        _arguments '--json[Output version as JSON]' '--help[Show version help]'
        return
        ;;
      usage)
        _arguments '--json[Output as JSON]' '--session=[Session id]' '--today[Today only]' '--help[Show usage help]'
        return
        ;;
      budget)
        subcommands=('show:Display current budget' 'set:Set budget amount' 'clear:Clear budget')
        ;;
      doctor)
        _arguments '--json[Output as JSON]' '--help[Show doctor help]'
        return
        ;;
      plugin)
        subcommands=('list:List installed plugins' 'install:Install plugin from directory' 'remove:Uninstall plugin' 'info:Show plugin metadata')
        ;;
      pr)
        subcommands=('review:Review GitHub pull request')
        ;;
      audit)
        subcommands=('show:Show audit trail' 'clear:Clear audit logs')
        ;;
      telemetry)
        subcommands=('status:Show telemetry state' 'enable:Enable telemetry' 'disable:Disable telemetry')
        ;;
    esac
  fi

  if (( CURRENT == 2 )) && [[ -n "\${subcommands[1]}" ]]; then
    _describe -t subcommands 'subcommand' subcommands
  else
    _describe -t commands 'toolnet command' commands

    _arguments -s \
      '(-v --version)'{-v,--version}'[Print version]' \
      '(-h --help)'{-h,--help}'[Show help]' \
      '(-p --prompt)'{-p,--prompt}'=[Run non-interactively with prompt]' \
      '(-s --simple)'{-s,--simple}'[Launch lightweight REPL]' \
      '(-b --bypass)'{-b,--bypass}'=[Enable bypass mode level]' \
      '--no-splash[Skip startup splash]' \
      '--verbose[Enable verbose output]' \
      '--json[JSON output format]' \
      '--format=[Output format: text|markdown|json|jsonl]' \
      '(-r --resume)'{-r,--resume}'[Resume last session]' \
      '--session=[Specific session id]' \
      '(-m --model)'{-m,--model}'=[Default model to use]'
  fi
}

_toolnet "\$@"
`;

const fishCompletion = `# fish completions for toolnet

complete -c toolnet -f

# Top-level flags
complete -c toolnet -s h -l help -d 'Show help'
complete -c toolnet -s v -l version -d 'Print version'
complete -c toolnet -s p -l prompt -r -d 'Run non-interactively with prompt'
complete -c toolnet -s s -l simple -d 'Launch lightweight REPL'
complete -c toolnet -s b -l bypass -r -d 'Enable bypass mode level'
complete -c toolnet -l no-splash -d 'Skip startup splash'
complete -c toolnet -l verbose -d 'Enable verbose output'
complete -c toolnet -l json -d 'JSON output format'
complete -c toolnet -l format -r -d 'Output format: text|markdown|json|jsonl'
complete -c toolnet -s r -l resume -d 'Resume last session'
complete -c toolnet -l session -r -d 'Specific session id'
complete -c toolnet -s m -l model -r -d 'Default model to use'

# Subcommands
complete -c toolnet -n '__fish_use_subcommand' -a config -d 'Show or modify configuration'
complete -c toolnet -n '__fish_use_subcommand' -a provider -d 'Manage and switch AI providers'
complete -c toolnet -n '__fish_use_subcommand' -a session -d 'Manage and resume sessions'
complete -c toolnet -n '__fish_use_subcommand' -a resume -d 'Resume last active session or by ID'
complete -c toolnet -n '__fish_use_subcommand' -a skills -d 'View and manage agent skills'
complete -c toolnet -n '__fish_use_subcommand' -a tools -d 'Inspect registered local and MCP tools'
complete -c toolnet -n '__fish_use_subcommand' -a queue -d 'Inspect and manage task queue'
complete -c toolnet -n '__fish_use_subcommand' -a completion -d 'Generate shell completion scripts'
complete -c toolnet -n '__fish_use_subcommand' -a update -d 'Check for and apply updates'
complete -c toolnet -n '__fish_use_subcommand' -a version -d 'Show version information'
complete -c toolnet -n '__fish_use_subcommand' -a usage -d 'Show token usage'
complete -c toolnet -n '__fish_use_subcommand' -a budget -d 'Manage spending budget'
complete -c toolnet -n '__fish_use_subcommand' -a doctor -d 'Run diagnostic checks'
complete -c toolnet -n '__fish_use_subcommand' -a plugin -d 'Manage plugins'
complete -c toolnet -n '__fish_use_subcommand' -a pr -d 'Review pull requests'
complete -c toolnet -n '__fish_use_subcommand' -a issue -d 'Analyze repo issues'
complete -c toolnet -n '__fish_use_subcommand' -a audit -d 'Audit log inspection'
complete -c toolnet -n '__fish_use_subcommand' -a telemetry -d 'Telemetry preferences'

# config sub-subcommands
complete -c toolnet -n '__fish_seen_subcommand_from config' -a init -d 'Run first-run setup wizard'
complete -c toolnet -n '__fish_seen_subcommand_from config' -a show -d 'Display current config'
complete -c toolnet -n '__fish_seen_subcommand_from config' -a path -d 'Print config file path'
complete -c toolnet -n '__fish_seen_subcommand_from config' -a get -d 'Get a config value'
complete -c toolnet -n '__fish_seen_subcommand_from config' -a set -d 'Set a config value'

# provider subcommands
complete -c toolnet -n '__fish_seen_subcommand_from provider' -a 'toolnet openai anthropic google groq openrouter deepseek' -d 'Select provider'

# session subcommands
complete -c toolnet -n '__fish_seen_subcommand_from session' -a 'current list resume delete' -d 'Session actions'

# completion sub-subcommands
complete -c toolnet -n '__fish_seen_subcommand_from completion' -a bash -d 'Bash completion script'
complete -c toolnet -n '__fish_seen_subcommand_from completion' -a zsh -d 'Zsh completion script'
complete -c toolnet -n '__fish_seen_subcommand_from completion' -a fish -d 'Fish completion script'

# update flags
complete -c toolnet -n '__fish_seen_subcommand_from update' -l check -d 'Only check, do not apply'
complete -c toolnet -n '__fish_seen_subcommand_from update' -l yes -s y -d 'Skip confirmation prompts'
complete -c toolnet -n '__fish_seen_subcommand_from update' -l force -s f -d 'Force update even if same version'

# version flags
complete -c toolnet -n '__fish_seen_subcommand_from version' -l json -d 'Output version as JSON'

# usage flags
complete -c toolnet -n '__fish_seen_subcommand_from usage' -l json -d 'Output as JSON'
complete -c toolnet -n '__fish_seen_subcommand_from usage' -l session -r -d 'Session id'
complete -c toolnet -n '__fish_seen_subcommand_from usage' -l today -d 'Today only'

# budget subcommands
complete -c toolnet -n '__fish_seen_subcommand_from budget' -a show -d 'Show budget'
complete -c toolnet -n '__fish_seen_subcommand_from budget' -a set -d 'Set budget'
complete -c toolnet -n '__fish_seen_subcommand_from budget' -a clear -d 'Clear budget'

# doctor flags
complete -c toolnet -n '__fish_seen_subcommand_from doctor' -l json -d 'Output as JSON'
`;

export type ShellName = "bash" | "zsh" | "fish";

export function generateCompletionScript(shell: ShellName): string {
  switch (shell) {
    case "bash":
      return bashCompletion;
    case "zsh":
      return zshCompletion;
    case "fish":
      return fishCompletion;
  }
}

export function getCompletionInstallHelp(): string {
  return `Shell Completion Installation:

Bash:
  toolnet completion bash > ~/.local/share/bash-completion/completions/toolnet
  # or add to ~/.bashrc:
  source <(toolnet completion bash)

Zsh:
  mkdir -p ~/.zfunc
  toolnet completion zsh > ~/.zfunc/_toolnet
  # add to ~/.zshrc before compinit:
  fpath+=~/.zfunc
  autoload -Uz compinit && compinit

Fish:
  mkdir -p ~/.config/fish/completions
  toolnet completion fish > ~/.config/fish/completions/toolnet.fish
`;
}
