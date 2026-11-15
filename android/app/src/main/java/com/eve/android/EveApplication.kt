package com.eve.android
import android.app.Application
import com.eve.android.data.EveRepository
class EveApplication : Application() { val repository by lazy { EveRepository(this) } }
