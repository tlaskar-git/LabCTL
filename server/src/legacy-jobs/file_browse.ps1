# File Browser: ACTION=list (the folder PATH as a table) or ACTION=read (the first MAX_SIZE characters of the file PATH).
$path = Get-Param 'PATH' 'C:\'
switch (Get-Param 'ACTION' 'list') {
    'list' {
        try { $items = Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop } catch { Die $_.Exception.Message }
        Show ($items | Format-Table Mode, Length, LastWriteTime, Name -AutoSize)
    }
    'read' {
        $max = 0
        if (-not [int]::TryParse((Get-Param 'MAX_SIZE' '50000'), [ref]$max) -or $max -lt 0) { Die 'MAX_SIZE must be a whole number.' }
        try { $text = Get-Content -LiteralPath $path -Raw -ErrorAction Stop } catch { Die $_.Exception.Message }
        if ($null -eq $text) { $text = '' }
        [Console]::Out.Write($text.Substring(0, [math]::Min($max, $text.Length)))
    }
    default { Die 'Unknown action' }
}
exit 0
