# Dumps the UIA control-view tree of the top-level windows owned by one pid (names, roles, values only).
param([int]$ProcId, [int]$MaxDepth = 12, [int]$MaxNodes = 400)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty), $ProcId
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:count = 0
function Dump($el, $depth) {
  if ($script:count -ge $MaxNodes -or $depth -gt $MaxDepth) { return }
  $script:count++
  $c = $el.Current
  $val = ''
  try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $val = ' value="' + $vp.Current.Value + '"' } catch {}
  $tog = ''
  try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $tog = ' toggle=' + $tp.Current.ToggleState } catch {}
  $pats = ($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers.Pattern','' }) -join ','
  Write-Output ('{0}{1} name="{2}" id="{3}" class="{4}"{5}{6} patterns=[{7}]' -f ('  ' * $depth), $c.ControlType.ProgrammaticName.Replace('ControlType.',''), $c.Name, $c.AutomationId, $c.ClassName, $val, $tog, $pats)
  $child = $walker.GetFirstChild($el)
  while ($child -ne $null) { Dump $child ($depth + 1); $child = $walker.GetNextSibling($child) }
}
foreach ($w in $wins) { Dump $w 0 }
Write-Output "nodes=$script:count"
