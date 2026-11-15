package com.eve.android

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import com.eve.android.ui.EveApp
import com.journeyapps.barcodescanner.CaptureActivity

class MainActivity : ComponentActivity() {
    private val pairingUri = mutableStateOf<String?>(null)
    private val repo get() = (application as EveApplication).repository
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        consume(intent)
        setContent { EveApp(repo, pairingUri.value) { pairingUri.value = null } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); consume(intent) }
    private fun consume(intent: Intent?) {
        if (intent?.action == Intent.ACTION_VIEW) {
            pairingUri.value = intent.dataString
            intent.data = null // Do not leave the credential in an activity's retained Intent.
        }
    }
    override fun onStart() { super.onStart(); repo.setForeground(true) }
    override fun onStop() { repo.setForeground(false); super.onStop() }
}
class SecureCaptureActivity : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
    }
}
