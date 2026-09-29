' start_floodreal_hidden.vbs - รัน Flood real แบบซ่อนหน้าต่าง (ใช้ตอน autostart)
Dim sh, fso, folder
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
' 0 = ซ่อนหน้าต่าง, False = ไม่ต้องรอ
sh.Run "pyw -3.13 " & Chr(34) & folder & "\floodreal_server.py" & Chr(34), 0, False
