#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Menu','List','Rename','Sort')][string]$Action='Menu',
    [string]$TabId,
    [string]$Name,
    [switch]$Apply,
    [switch]$AsJson
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)

if($env:SSH_CONNECTION -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){
    throw 'Windows Terminal 탭 정리는 로그인한 PC에서 실행하세요.'
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms
if(-not ('AiccTerminalTabInput' -as [type])){
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AiccTerminalTabInput {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
"@
}

function Find-Elements($Root,$Property,$Value){
    $condition=[Windows.Automation.PropertyCondition]::new($Property,$Value)
    $Root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition) | ForEach-Object {$_}
}

function Read-Tabs($Window){
    $root=[Windows.Automation.AutomationElement]::FromHandle($Window)
    $lists=@(Find-Elements $root ([Windows.Automation.AutomationElement]::AutomationIdProperty) 'TabListView')
    if($lists.Count -ne 1){throw '탭 목록을 확인할 수 없습니다. Windows Terminal 메뉴나 대화 상자를 닫으세요.'}
    $condition=[Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem)
    $items=$lists[0].FindAll([Windows.Automation.TreeScope]::Children,$condition)
    for($i=0;$i -lt $items.Count;$i++){
        $element=$items.Item($i)
        $selected=$element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
        [pscustomobject]@{
            Number=$i+1; Id=($element.GetRuntimeId() -join '.'); Name=$element.Current.Name
            Selected=$selected.Current.IsSelected; Element=$element
        }
    }
}

function Find-MenuItem($Root,[string[]]$Names){
    $matches=@(foreach($label in $Names){
        Find-Elements $Root ([Windows.Automation.AutomationElement]::NameProperty) $label |
            Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::MenuItem -and
                $_.Current.IsEnabled -and -not $_.Current.IsOffscreen}
    })
    if($matches.Count -ne 1){throw ('메뉴 항목을 확인하지 못했습니다. '+($Names -join ' / '))}
    $matches[0]
}

function Assert-Foreground($Window){
    if([AiccTerminalTabInput]::GetForegroundWindow() -ne $Window){
        throw 'Windows Terminal이 앞에 있지 않습니다. 작업을 멈췄습니다.'
    }
}

function Open-TabMenu($Window,$Tab){
    Assert-Foreground $Window
    $r=$Tab.Element.Current.BoundingRectangle
    $point=[AiccTerminalTabInput+Point]::new()
    $point.X=[int]($r.Left+$r.Width/3)
    $point.Y=[int]($r.Top+$r.Height/2)
    if($r.IsEmpty -or $Tab.Element.Current.IsOffscreen -or
        [AiccTerminalTabInput]::GetAncestor([AiccTerminalTabInput]::WindowFromPoint($point),2) -ne $Window){
        throw '대상 탭이 보이지 않습니다. 탭이 보이도록 한 뒤 다시 미리보기를 확인하세요.'
    }
    [void][AiccTerminalTabInput]::SetCursorPos($point.X,$point.Y)
    Assert-Foreground $Window
    [AiccTerminalTabInput]::mouse_event(8,0,0,0,[UIntPtr]::Zero)
    [AiccTerminalTabInput]::mouse_event(16,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 180
}

function Get-NumberedOrder($Tabs){
    $Tabs | Sort-Object @{Expression={
        if($_.Name -match '^([0-9]{1,3})(?=\s|[.·-]|$)'){[int]$Matches[1]}
        else{[int]::MaxValue}
    }},Number
}

function Show-TabList($Rows){
    $view=@($Rows|Select-Object Number,Name,Id,Selected)
    if($AsJson){ConvertTo-Json -InputObject $view -Compress}
    else{$view | Format-Table -AutoSize | Out-Host}
}

function Invoke-TabEdit($Window,$Before,$Desired,$Rename){
    $mutex=[Threading.Mutex]::new($false,'Local\AiccTerminalTabs')
    $locked=$false
    $cursor=[AiccTerminalTabInput+Point]::new()
    $cursorCaptured=$false
    try{
        try{$locked=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
        if(-not $locked){throw '다른 탭 정리 작업이 실행 중입니다.'}
        Assert-Foreground $Window
        $cursorCaptured=[AiccTerminalTabInput]::GetCursorPos([ref]$cursor)
        $root=[Windows.Automation.AutomationElement]::FromHandle($Window)
        $current=@(Read-Tabs $Window)
        if(($current.Id -join '|') -cne ($Before.Id -join '|') -or
            (ConvertTo-Json -InputObject @($current.Name) -Compress) -cne (ConvertTo-Json -InputObject @($Before.Name) -Compress)){
            throw '미리보기 이후 탭이 바뀌었습니다. 새 목록을 확인하세요.'
        }
        if($Rename){
            $tab=$current|Where-Object Id -CEQ $Rename.Id
            Open-TabMenu $Window $tab
            (Find-MenuItem $root @('탭 이름 바꾸기','Rename Tab','Rename tab')).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
            Start-Sleep -Milliseconds 180
            $field=[Windows.Automation.AutomationElement]::FocusedElement
            $parent=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($field)
            if($field.Current.AutomationId -cne 'HeaderRenamerTextBox' -or ($parent.GetRuntimeId() -join '.') -cne $tab.Id){
                throw '이름 입력란이 대상 탭에 속하는지 확인하지 못했습니다.'
            }
            $field.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Rename.Name)
            Assert-Foreground $Window
            if(([Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join '.') -cne ($field.GetRuntimeId() -join '.')){
                throw '이름 입력란에서 포커스가 이동했습니다.'
            }
            [Windows.Forms.SendKeys]::SendWait('{ENTER}')
            Start-Sleep -Milliseconds 180
        }else{
            for($i=0;$i -lt $Desired.Count;$i++){
                $tab=$current|Where-Object Id -CEQ $Desired[$i].Id
                while($tab.Number -gt $i+1){
                    $priorNumber=$tab.Number
                    Open-TabMenu $Window $tab
                    (Find-MenuItem $root @('탭 이동','Move Tab','Move tab')).GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
                    Start-Sleep -Milliseconds 180
                    Assert-Foreground $Window
                    (Find-MenuItem $root @('왼쪽으로 이동','Move Left','Move left')).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
                    Start-Sleep -Milliseconds 165
                    $current=@(Read-Tabs $Window)
                    $tab=$current|Where-Object Id -CEQ $Desired[$i].Id
                    if($current.Count -ne $Before.Count -or @($current|Where-Object {$_.Id -cnotin $Before.Id}).Count -or
                        $tab.Number -ne $priorNumber-1){
                        throw '탭 이동 결과를 확인하지 못했습니다. 현재 목록을 새로 확인하세요.'
                    }
                }
            }
        }
        $after=@(Read-Tabs $Window)
        if(($after.Id -join '|') -cne ($Desired.Id -join '|') -or
            (ConvertTo-Json -InputObject @($after.Name) -Compress) -cne (ConvertTo-Json -InputObject @($Desired.Name) -Compress)){
            throw '최종 탭 목록이 미리보기와 다릅니다. 현재 목록을 새로 확인하세요.'
        }
        $selected=$Before|Where-Object Selected
        if($selected){
            Assert-Foreground $Window
            $element=($after|Where-Object Id -CEQ $selected.Id).Element
            $element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
        }
        if(-not $AsJson){Write-Host 'Windows Terminal 탭 변경 확인 완료'}
        Show-TabList @(Read-Tabs $Window)
    }finally{
        if($locked){$mutex.ReleaseMutex()}
        if($cursorCaptured -and [AiccTerminalTabInput]::GetForegroundWindow() -eq $Window){
            [void][AiccTerminalTabInput]::SetCursorPos($cursor.X,$cursor.Y)
        }
        $mutex.Dispose()
    }
}

$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$hosts=@(Get-Process WindowsTerminal -ErrorAction SilentlyContinue|Where-Object {$_.SessionId -eq $session -and $_.MainWindowHandle -ne 0})
$foreground=[AiccTerminalTabInput]::GetForegroundWindow()
$terminal=$hosts|Where-Object MainWindowHandle -eq $foreground|Select-Object -First 1
if(-not $terminal -and -not $Apply -and $Action -ne 'Menu' -and $hosts.Count -eq 1){$terminal=$hosts[0]}
if(-not $terminal){throw '대상 Windows Terminal 창을 앞으로 띄우세요.'}
$window=$terminal.MainWindowHandle
$tabs=@(Read-Tabs $window)
if(-not $tabs.Count){throw '열린 Windows Terminal 탭이 없습니다.'}
if($Action -eq 'List'){Show-TabList $tabs;return}
if($Action -eq 'Menu'){
    Show-TabList $tabs
    $choice=Read-Host '1 이름 바꾸기 / 2 번호순 정렬 / Enter 닫기'
    switch($choice){
        '1' {
            $pick=Read-Host '바꿀 탭의 목록 번호'
            if($pick -notmatch '^[0-9]+$' -or $pick -notin $tabs.Number){throw '목록에 있는 번호를 입력하세요.'}
            $TabId=($tabs|Where-Object Number -eq $pick).Id
            $Name=Read-Host '새 이름'
            if(-not $Name){return}
            $Action='Rename'
        }
        '2' {$Action='Sort'}
        default {return}
    }
}
$rename=$null
if($Action -eq 'Rename'){
    $row=@($tabs|Where-Object Id -CEQ $TabId)
    if($row.Count -ne 1 -or -not $Name -or $Name.Length -gt 120 -or $Name.Trim() -cne $Name -or $Name -match '[\p{Cc}\p{Cf}]'){
        throw '정확한 탭 ID와 제어문자 없는 이름(1~120자)이 필요합니다.'
    }
    $rename=[pscustomobject]@{Id=$TabId;Name=$Name}
    $desired=@(foreach($tab in $tabs){
        $shown=if($tab.Id -ceq $TabId){$Name}else{$tab.Name}
        [pscustomobject]@{Number=$tab.Number;Id=$tab.Id;Name=$shown;Selected=$tab.Selected}
    })
}else{
    $i=0
    $desired=@(Get-NumberedOrder $tabs | ForEach-Object {
        [pscustomobject]@{Number=(++$i);Id=$_.Id;Name=$_.Name;Selected=$_.Selected}
    })
}
if(-not $Apply){
    Show-TabList $desired
    if($PSBoundParameters.ContainsKey('Action') -and $PSBoundParameters['Action'] -ne 'Menu'){return}
    if((Read-Host '위 목록대로 적용하려면 Y') -ine 'Y'){return}
}
if(($tabs.Id -join '|') -ceq ($desired.Id -join '|') -and
    (ConvertTo-Json -InputObject @($tabs.Name) -Compress) -ceq (ConvertTo-Json -InputObject @($desired.Name) -Compress)){
    if(-not $AsJson){Write-Host '이미 같은 이름과 순서입니다.'}
    Show-TabList $tabs
    return
}
Invoke-TabEdit $window $tabs $desired $rename
