/**
 * Shell completion scripts for ToolNet CLI.
 *
 * Output is just text to redirect:
 *   toolnet completion bash > ~/.local/share/bash-completion/completions/toolnet
 *   toolnet completion zsh  > ~/.local/share/zsh-completions/_toolnet
 *   toolnet completion fish > ~/.config/fish/completions/toolnet.fish
 */

const SUBCOMMANDS = "config completion update version usage budget doctor";

const TOP_FLAGS = "--help -h --version -v --resume --session --model --json --no-splash --verbose --simple -s --prompt -p -b --bypass --format";

const CONFIG_SUBCOMMANDS = "init show path";

const bashCompletion = `# bash completion for toolnet
_toolnet_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local subcmds="${SUBCOMMANDS}"
  local top_flags="${TOP_FLAGS}"

  # If we're right after a known subcommand
  if (( COMP_CWORD >= 2 )); then
    local subcmd="\${COMP_WORDS[1]}"
    case "\${subcmd}" in
      config)
        COMPREPLY=( $(compgen -W "init show path get set" -- "\${cur}") )
        return 0
        ;;
      completion)
        COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
        return 0
        ;;
      update)
        COMPREPLY=( $(compgen -W "--check --yes -y --force -f --help" -- "\${cur}") )
        return 0
        ;;
      version)
        COMPREPLY=( $(compgen -W "--json" -- "\${cur}") )
        return 0
        ;;
      usage)
        COMPREPLY=( $(compgen -W "--json --session --today" -- "\${cur}") )
        return 0
        ;;
      budget)
        COMPREPLY=( $(compgen -W "show set clear" -- "\${cur}") )
        return 0
        ;;
      doctor)
        COMPREPLY=( $(compgen -W "--json" -- "\${cur}") )
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
    'completion:Generate shell completion scripts'
    'update:Check for and apply updates'
    'version:Show version information'
    'usage:Show token usage for current session'
    'budget:Manage spending budget'
    'doctor:Run diagnostic checks'
  )

  subcommands=()
  if (( CURRENT > 1 )); then
    case \${words[2]} in
      config)
        subcommands=('init:Run the first-run setup wizard' 'show:Display current config' 'path:Print config file path' 'get:Get a config value' 'set:Set a config value')
        ;;
      completion)
        subcommands=('bash:Bash completion script' 'zsh:Zsh completion script' 'fish:Fish completion script')
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
        _arguments '--json[Output version as JSON]'
        return
        ;;
      usage)
        _arguments '--json[Output as JSON]' '--session=[Session id]' '--today[Today only]'
        return
        ;;
      budget)
        _arguments '1:command:(show set clear)'
        return
        ;;
      doctor)
        _arguments '--json[Output as JSON]'
        return
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
      '--resume[Resume last session]' \
      '--session=[Specific session id]' \
      '--model=[Default model to use]'
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
complete -c toolnet -l resume -d 'Resume last session'
complete -c toolnet -l session -r -d 'Specific session id'
complete -c toolnet -l model -r -d 'Default model to use'

# Subcommands
complete -c toolnet -n '__fish_use_subcommand' -a config -d 'Show or modify configuration'
complete -c toolnet -n '__fish_use_subcommand' -a completion -d 'Generate shell completion scripts'
complete -c toolnet -n '__fish_use_subcommand' -a update -d 'Check for and apply updates'
complete -c toolnet -n '__fish_use_subcommand' -a version -d 'Show version information'
complete -c toolnet -n '__fish_use_subcommand' -a usage -d 'Show token usage'
complete -c toolnet -n '__fish_use_subcommand' -a budget -d 'Manage spending budget'
complete -c toolnet -n '__fish_use_subcommand' -a doctor -d 'Run diagnostic checks'

# config sub-subcommands
complete -c toolnet -n '__fish_seen_subcommand_from config' -a init -d 'Run first-run setup wizard'
complete -c toolnet -n '__fish_seen_subcommand_from config' -a show -d 'Display current config'
complete -c toolnet -n '__fish_seen_subcommand_from config' -a path -d 'Print config file path'
complete -c toolnet -n '__fish_seen_subcommand_from config' -a get -d 'Get a config value'
complete -c toolnet -n '__fish_seen_subcommand_from config' -a set -d 'Set a config value'

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
    case "bash": return bashCompletion;
    case "zsh":  return zshCompletion;
    case "fish": return fishCompletion;
  }
}
